import { CLIS } from '../shared/clis.ts'
import type { CliStatus } from '../shared/schema.ts'
import { cliSettings, defaultCli, orderClis } from '../shared/settings.ts'
import { capture, childEnv } from './exec/process.ts'
import { cliSource, resolveCommand } from './cli-source.ts'
import { getSettings } from './settings.ts'
import { refreshWinPath } from './win-path.ts'
import { t } from '../shared/i18n.ts'

// 检测要把每个 CLI 都跑一遍 --version（Windows 上一次要一两秒），结果多留一会儿；
// 设置里改了命令或环境变量时自动重新检测，在面板里装、卸 CLI 时也会清掉
const TTL = 5 * 60_000
let cached: { at: number; key: string; data: CliStatus[] } | null = null

export const invalidateClis = () => {
  cached = null
  running = null
}

let running: { key: string; p: Promise<CliStatus[]> } | null = null

/**
 * 检测每个 CLI 是否装在本机（使用设置里的可执行文件和环境变量）。
 * 结果过期后先返回上次的结果、在后台重新检测，打开页面不用等每个 CLI 跑完 --version
 */
export async function detectClis(force = false): Promise<CliStatus[]> {
  // 在面板外面装的 CLI（Windows 安装包、winget）只改了注册表里的 PATH，重新检测时补进来
  if (force) await refreshWinPath(true)
  const settings = await getSettings()
  // 启用状态、默认 CLI 不走缓存，设置改了立即生效；启用的排在前面
  const mark = (data: CliStatus[]) =>
    orderClis(
      data.map((c) => ({
        ...c,
        enabled: cliSettings(settings, c.id).enabled,
        isDefault: c.id === defaultCli(settings),
      })),
      settings.cliOrder,
      (c) => c.enabled,
    )
  const key = JSON.stringify(CLIS.map((c) => [cliSettings(settings, c.id).command, cliSettings(settings, c.id).env]))
  if (!force && cached?.key === key) {
    if (Date.now() - cached.at > TTL) void probe(key, settings).catch(() => {})
    return mark(cached.data)
  }
  return mark(await probe(key, settings))
}

/** 真正跑一遍检测；同时有好几个请求时只跑一次 */
function probe(key: string, settings: Awaited<ReturnType<typeof getSettings>>) {
  if (running?.key === key) return running.p
  const p = Promise.all(
    CLIS.map(async (c): Promise<CliStatus> => {
      const cs = cliSettings(settings, c.id)
      const r = await capture(cs.command, c.versionArgs, process.cwd(), childEnv(cs.env), 10_000)
      const out = (r.stdout || r.stderr).trim().split('\n')[0] ?? ''
      const installed = !r.spawnError && !r.killed && r.code === 0
      const env = childEnv(cs.env)
      const file = installed ? resolveCommand(cs.command, env) : undefined
      return {
        path: file,
        source: installed ? await cliSource(c.id, file) : undefined,
        id: c.id,
        name: c.name,
        command: cs.command,
        enabled: cs.enabled,
        installed,
        version: installed ? out : undefined,
        error: installed
          ? undefined
          : (r.spawnError ?? (r.killed ? t('检测超时') : out || t('退出码 {code}', { code: String(r.code) }))),
        models: c.models,
        docsUrl: c.docsUrl,
      }
    }),
  )
    .then((data) => {
      // 检测期间被清掉（刚装、卸了 CLI）的话，这次的结果已经不准，不存
      if (running?.p === p) cached = { at: Date.now(), key, data }
      return data
    })
    .finally(() => {
      if (running?.p === p) running = null
    })
  running = { key, p }
  return p
}
