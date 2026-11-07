import type { RemoteAccess } from '../shared/schema.ts'
import type { TailscaleInfo } from '../shared/remote.ts'
import { t } from '../shared/i18n.ts'
import { capture, childEnv } from './exec/process.ts'
import { resolveCommand } from './cli-source.ts'
import { refreshWinPath } from './win-path.ts'

/**
 * Tailscale 方式：用户自己装好并登录 Tailscale，面板调 `tailscale serve`（只有自己 tailnet 里的设备能打开，
 * 自带 HTTPS 证书）或 `tailscale funnel`（开到公网）把 https://<机器名>.<tailnet>.ts.net 转到外网专用端口。
 * 不用公网 IP、不用云服务器；面板只管起停这一条转发，不碰用户 serve 里的其他配置（关的时候只关自己那个端口，不 reset）
 */

const isWin = process.platform === 'win32'
/** 安装包装好后 tailscale 不一定在 PATH 里：Windows 装在 Program Files，macOS 的 App Store 版命令在 App 包里 */
const CANDIDATES = isWin
  ? [`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`, 'tailscale']
  : process.platform === 'darwin'
    ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
    : ['tailscale']

const run = (bin: string, args: string[], timeoutMs = 15_000) =>
  capture(bin, args, process.cwd(), childEnv([]), timeoutMs)

/** 命令的输出里取最后几行给用户看（tailscale 的报错会说清楚要做什么，例如去后台打开 Funnel） */
const tail = (r: { stdout: string; stderr: string; spawnError?: string }) =>
  (r.spawnError ?? `${r.stderr}\n${r.stdout}`).trim().split('\n').slice(-4).join('\n').slice(-600)

/** 检测 tailscale：装没装、版本、登录没有、这台机器在 tailnet 里的域名 */
export async function tailscaleInfo(command: string): Promise<TailscaleInfo> {
  await refreshWinPath()
  const list = [...new Set([command.trim(), ...CANDIDATES].filter(Boolean))]
  for (const c of list) {
    const v = await run(c, ['version'], 5000)
    if (v.spawnError || v.killed || v.code !== 0) continue
    const path = resolveCommand(c, process.env) ?? c
    const version = v.stdout.trim().split('\n')[0] ?? ''
    const st = await run(path, ['status', '--json'], 8000)
    let running = false
    let dnsName = ''
    try {
      const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { DNSName?: string } }
      running = j.BackendState === 'Running'
      dnsName = (j.Self?.DNSName ?? '').replace(/\.$/, '')
    } catch {}
    return {
      installed: true,
      version,
      path,
      running,
      dnsName,
      error: running ? '' : t('Tailscale 还没登录或没有连上：打开 Tailscale 登录后点「重新检测」'),
    }
  }
  return {
    installed: false,
    version: '',
    path: '',
    running: false,
    dnsName: '',
    error: t('没有找到 tailscale：请先安装 Tailscale 并登录'),
  }
}

/** serve 或 funnel 对外的地址：443 不写端口 */
export const tailscaleUrl = (dnsName: string, port: number) =>
  dnsName ? `https://${dnsName}${port === 443 ? '' : `:${port}`}` : ''

/** 开转发：把 https 端口转到本机外网专用端口；失败抛出 tailscale 自己的报错 */
export async function tailscaleStart(bin: string, s: RemoteAccess['tailscale'], localPort: number) {
  const verb = s.funnel ? 'funnel' : 'serve'
  // 先关掉另一种（serve 和 funnel 用的是同一个 https 端口），免得切换后还留着公网入口
  await run(bin, [s.funnel ? 'serve' : 'funnel', `--https=${s.httpsPort}`, 'off']).catch(() => {})
  const r = await run(bin, [verb, '--bg', `--https=${s.httpsPort}`, `http://127.0.0.1:${localPort}`])
  if (r.spawnError || r.killed || r.code !== 0)
    throw new Error(t('tailscale {verb} 没有成功：{log}', { verb, log: tail(r) || String(r.code) }))
}

/** 关掉面板开的那条转发（只关这个端口，用户自己配的别的 serve 不动） */
export async function tailscaleStop(bin: string, s: RemoteAccess['tailscale']) {
  await run(bin, ['funnel', `--https=${s.httpsPort}`, 'off']).catch(() => {})
  await run(bin, ['serve', `--https=${s.httpsPort}`, 'off']).catch(() => {})
}
