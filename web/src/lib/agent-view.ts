import { agentCli, defaultSettings, modelText } from '@shared/settings'
import { useData } from './data'
import { t } from '@shared/i18n'

/** 列表和任务页显示 Agent 用：系统默认的 CLI、模型档位换成实际值 */
export function useAgentView() {
  const { settings, clis } = useData()
  const s = settings ?? defaultSettings()
  return {
    cliOf: (a: { cli: string }) => agentCli(a, s),
    cliName: (a: { cli: string }) => {
      const id = agentCli(a, s)
      const name = clis.find((c) => c.id === id)?.name.split(' ')[0] ?? id
      return a.cli ? name : t('{name}（默认）', { name })
    },
    modelOf: (a: { cli: string; model: string }) => modelText(a, s),
  }
}
