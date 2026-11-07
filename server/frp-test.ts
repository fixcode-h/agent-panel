import { connect } from 'node:net'
import type { RemoteAccess } from '../shared/schema.ts'
import type { FrpTestStep, RemoteState } from '../shared/remote.ts'
import { t } from '../shared/i18n.ts'

/**
 * frp 的连接测试：从本机按「配置 → 本机外网端口 → 云服务器 frp 端口 → frpc → 经云服务器打开面板」的顺序逐段试，
 * 哪一段断了就停下，并说清楚该去查什么。最后一段真的从外面绕一圈打开面板的登录探测接口，
 * 回的是面板自己的响应才算通（端口被别的程序占着时也能连上，但回的不是面板）
 */

/** TCP 连一下，返回耗时；失败时抛出带 code 的错误 */
export function tcpPing(host: string, port: number, timeoutMs = 5000) {
  const started = Date.now()
  return new Promise<number>((resolve, reject) => {
    const sock = connect({ host, port })
    const done = (e?: Error) => {
      sock.destroy()
      if (e) reject(e)
      else resolve(Date.now() - started)
    }
    sock.setTimeout(timeoutMs, () => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    sock.once('connect', () => done())
    sock.once('error', (e) => done(e))
  })
}

/** 连云服务器失败的原因翻成该去查什么：按错误原因分，不按笼统的「连不上」 */
export function serverHint(code: string | undefined, port: number) {
  if (code === 'ECONNREFUSED')
    return t(
      '服务器上 {port} 端口没有程序在监听：frps 没在运行，在服务器上执行 sudo systemctl status agent-panel-frps 查看，或重新一键配置。',
      {
        port: String(port),
      },
    )
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('解析不了服务器地址：检查填的 IP 或域名。')
  if (code === 'ETIMEDOUT')
    return t('连接 {port} 端口超时：请在云服务器控制台的「安全组 → 入方向」放行 TCP {port}。', { port: String(port) })
  return t('连不上：{code}', { code: code ?? '' })
}

export async function frpTest(
  s: RemoteAccess,
  live: { localPort: number; frpcRunning: boolean; state: RemoteState; error: string },
): Promise<FrpTestStep[]> {
  const f = s.frp
  const host = f.server.includes(':') ? `[${f.server}]` : f.server
  const steps: FrpTestStep[] = [
    { id: 'config', title: t('配置'), ok: null, ms: 0, detail: '' },
    { id: 'local', title: t('本机外网端口'), ok: null, ms: 0, detail: '' },
    { id: 'server', title: t('云服务器 frp 端口 {port}', { port: String(f.bindPort) }), ok: null, ms: 0, detail: '' },
    { id: 'frpc', title: t('本机 frpc'), ok: null, ms: 0, detail: '' },
    { id: 'panel', title: t('从外网打开面板'), ok: null, ms: 0, detail: '' },
  ]
  const [config, local, server, frpc, panel] = steps
  // 按顺序测，断了就停：后面的步骤依赖前面的
  if (!s.enabled || s.mode !== 'frp' || !f.server || !f.token) {
    config.ok = false
    config.detail = !s.enabled
      ? t('外部访问没有打开')
      : s.mode !== 'frp'
        ? t('当前方式不是云服务器（frp）')
        : t('还没配置云服务器：填好服务器信息后点「一键配置」')
    return steps
  }
  config.ok = true
  config.detail = `${host}:${f.remotePort}`

  if (!live.localPort) {
    local.ok = false
    local.detail = live.error || t('外网专用端口没有在监听，点「重新连接」')
    return steps
  }
  try {
    local.ms = await tcpPing('127.0.0.1', live.localPort, 2000)
    local.ok = true
    local.detail = `127.0.0.1:${live.localPort}`
  } catch (e) {
    local.ok = false
    local.detail = (e as Error).message
    return steps
  }

  try {
    server.ms = await tcpPing(f.server, f.bindPort)
    server.ok = true
    server.detail = t('{ms} 毫秒', { ms: String(server.ms) })
  } catch (e) {
    server.ok = false
    server.detail = serverHint((e as NodeJS.ErrnoException).code, f.bindPort)
    return steps
  }

  frpc.ok = live.frpcRunning && live.state === 'running'
  frpc.detail = frpc.ok ? t('已连上云服务器') : live.error || t('frpc 还没连上，稍等几秒再测')
  if (!frpc.ok) return steps

  // 从外面绕一圈：本机 → 云服务器 remotePort → frps → frpc → 外网专用端口 → 面板登录门
  const started = Date.now()
  try {
    const res = await fetch(`http://${host}:${f.remotePort}/api/remote/guard/session`, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    })
    panel.ms = Date.now() - started
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null
    // 没登录回 401 {ok:false}：说明请求确实走到了面板的登录门
    panel.ok = (res.status === 200 || res.status === 401) && typeof body?.ok === 'boolean'
    panel.detail = panel.ok
      ? t('{ms} 毫秒，经云服务器到达面板', { ms: String(panel.ms) })
      : t('{port} 端口有响应（{status}），但回的不是面板：端口可能被服务器上别的程序占着', {
          port: String(f.remotePort),
          status: String(res.status),
        })
  } catch (e) {
    panel.ms = Date.now() - started
    panel.ok = false
    const cause = (e as { cause?: NodeJS.ErrnoException }).cause
    const code = (e as Error).name === 'TimeoutError' ? 'ETIMEDOUT' : cause?.code
    panel.detail = serverHint(code, f.remotePort)
  }
  return steps
}
