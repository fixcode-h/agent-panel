import type { ApiConfig } from '../../shared/accounts.ts'
import { apiModelInfo, type ModelCatalogEntry } from '../../shared/models/catalog.ts'
import { resolveSupport, type ResolvedSupport } from '../../shared/models/support.ts'
import { readHooks } from './store.ts'

/**
 * 这一轮按模型档位套用的扶持（shared/models/support.ts）：档位按 API 设置里的模型映射、在模型目录里查，
 * 和写 CLI 配置、夹思考强度走同一个 apiModelInfo，免得这里认成弱模型、别处认成强模型
 */
export async function turnSupport(
  model: string,
  api: Pick<ApiConfig, 'protocol' | 'modelMap'> | undefined,
  entries: ModelCatalogEntry[],
): Promise<ResolvedSupport> {
  const info = apiModelInfo(model, api, entries)
  const data = await readHooks()
  return resolveSupport(data.modelSupport, info.tier, info.matched)
}
