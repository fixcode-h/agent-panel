import { cliApi } from '@shared/accounts'
import { getCli } from '@shared/clis'
import { shownModelName } from '@shared/models/catalog'
import type { Settings } from '@shared/schema'
import { useData } from './data'

/**
 * 界面上显示的模型名：模型在 API 设置里配了映射就显示映射到的模型，不显示真实的模型名
 * （只有 API 配置页看真实模型名，那里不用这个）。
 * cli 给了按这个 Agent 现在用的 API 查；没给（例如只知道模型的用量记录）时在所有 API 里找配了映射的那个
 */
export function modelNameIn(settings: Settings | undefined, model: string, cli?: string) {
  if (!model || !settings) return model
  if (cli) {
    const cs = settings.clis?.[cli]
    if (cs?.authMode !== 'api') return model
    const api = cliApi(
      getCli(cli)?.auth,
      settings.apis.find((a) => a.id === cs.apiId),
      cs.apiProtocol,
    )
    return shownModelName(model, api)
  }
  for (const api of settings.apis) {
    const shown = shownModelName(model, api)
    if (shown !== model) return shown
  }
  return model
}

/** 组件里用：返回 (model, cli?) => 显示名 */
export function useModelName() {
  const { settings } = useData()
  return (model: string, cli?: string) => modelNameIn(settings ?? undefined, model, cli)
}
