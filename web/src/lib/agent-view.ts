import { agentCli, defaultSettings, modelText } from '@shared/settings'
import { useData } from './data'

/** 列表和任务页显示 Agent 用：系统默认的 CLI、模型档位换成实际值 */
export function useAgentView() {
  const { settings, clis } = useData()
  const s = settings ?? defaultSettings()
  return {
    cliOf: (a: { cli: string }) => agentCli(a, s),
    cliName: (a: { cli: string }) => {
      const id = agentCli(a, s)
      return (clis.find((c) => c.id === id)?.name.split(' ')[0] ?? id) + (a.cli ? '' : '（默认）')
    },
    modelOf: (a: { cli: string; model: string }) => modelText(a, s),
  }
}
