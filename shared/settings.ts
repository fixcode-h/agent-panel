import { getCli } from './clis.ts'
import { CliSettings, Settings } from './schema.ts'

export const defaultSettings = (): Settings => Settings.parse({})

/** 某个 CLI 的有效设置：没配置过的项用默认值补齐 */
export function cliSettings(settings: Settings, cliId: string): CliSettings & { command: string; permission: string } {
  const def = getCli(cliId)
  const s = CliSettings.parse(settings.clis[cliId] ?? {})
  return {
    ...s,
    command: s.command || def?.command || cliId,
    permission: s.permission || def?.defaultPermission || '',
  }
}
