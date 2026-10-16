import { CLIS } from '../shared/clis.ts'
import type { CliStatus } from '../shared/schema.ts'
import { cliSettings, defaultCli, orderClis } from '../shared/settings.ts'
import { capture, childEnv } from './exec/process.ts'
import { cliSource, resolveCommand } from './cli-source.ts'
import { getSettings } from './settings.ts'

const TTL = 30_000
let cached: { at: number; data: CliStatus[] } | null = null

export const invalidateClis = () => {
  cached = null
}

/** 检测每个 CLI 是否装在本机（使用设置里的可执行文件和环境变量，结果缓存 30 秒） */
export async function detectClis(force = false): Promise<CliStatus[]> {
  const settings = await getSettings()
  // 默认 CLI 不走缓存，设置改了立即生效
  const mark = (data: CliStatus[]) =>
    orderClis(data, settings.cliOrder).map((c) => ({ ...c, isDefault: c.id === defaultCli(settings) }))
  if (!force && cached && Date.now() - cached.at < TTL) return mark(cached.data)
  const data = await Promise.all(
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
        error: installed ? undefined : (r.spawnError ?? (r.killed ? '检测超时' : out || `退出码 ${r.code}`)),
        models: c.models,
        docsUrl: c.docsUrl,
      }
    }),
  )
  cached = { at: Date.now(), data }
  return mark(data)
}
