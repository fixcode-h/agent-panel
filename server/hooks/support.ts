import type { ApiConfig } from '../../shared/accounts.ts'
import { apiModelInfo, type ModelCatalogEntry } from '../../shared/models/catalog.ts'
import { resolveSupport, supportTierFor, type ResolvedSupport } from '../../shared/models/support.ts'
import type { ModelTier } from '../../shared/clis.ts'
import { readHooks } from './store.ts'

/**
 * 这一轮按模型档位套用的扶持（shared/models/support.ts）：模型本身的档按 API 设置里的模型映射、在模型目录里查，角色选了档位时以选的档为准（supportTierFor），
 * 和写 CLI 配置、夹思考强度走同一个 apiModelInfo，免得这里认成弱模型、别处认成强模型
 */
export async function turnSupport(
  model: string,
  api: Pick<ApiConfig, 'protocol' | 'modelMap'> | undefined,
  entries: ModelCatalogEntry[],
  /** 角色或节点选的档位（高 / 中 / 低）；直接写了模型名的没有 */
  slot?: ModelTier,
): Promise<ResolvedSupport> {
  const info = apiModelInfo(model, api, entries)
  const data = await readHooks()
  const tier = supportTierFor(info.tier, info.matched, slot)
  return { ...resolveSupport(data.modelSupport, tier, info.matched), from: { model: info.tier, ...(slot && { slot }) } }
}
