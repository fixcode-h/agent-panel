/**
 * 模型的上下文窗口和最大输出（token）。
 * 设置里三档模型的这两项默认按模型自动填：先用 CLI 读模型列表时给出的（Pi、Command Code 会报），
 * 再查模型目录（shared/model-catalog.json 加上用户的补充目录）；都没有时按 1M / 128K 估算。
 */
import type { ApiProtocol } from './accounts.ts'
import type { CliDefinition } from './clis.ts'
import type { ModelTier } from './clis.ts'
import {
  DEFAULT_MODEL_CONTEXT,
  DEFAULT_MODEL_MAX_OUTPUT,
  matchModel,
  modelLimitsFor,
  type ModelCatalogEntry,
} from './model-catalog.ts'

export interface ModelLimits {
  context?: number
  maxOutput?: number
}

export interface ResolvedLimits {
  context: number
  maxOutput: number
  /** 目录里的档位；没有命中时是中档 */
  tier: ModelTier
  /** 目录里这个模型可选的思考强度 */
  efforts: string[]
  /** 目录里这个模型默认的思考强度 */
  defaultEffort: string
  /** cli：CLI 读模型列表时报的；catalog：模型目录；default：按 1M / 128K 估算 */
  source: 'cli' | 'catalog' | 'default'
  matched: boolean
}

const bare = (model: string) => model.slice(model.lastIndexOf('/') + 1).toLowerCase()

/** 模型目录里这个模型的数值；不认识的模型返回空对象 */
export function knownLimits(
  model: string,
  entries: ModelCatalogEntry[] = [],
): ModelLimits & { tier?: ModelTier; efforts?: string[]; defaultEffort?: string; matched?: boolean } {
  if (!model) return {}
  const hit = matchModel(model, entries.length ? { entries } : {})
  return hit
    ? {
        context: hit.entry.context,
        maxOutput: hit.entry.maxOutput,
        tier: hit.tier,
        efforts: hit.entry.efforts,
        defaultEffort: hit.entry.defaultEffort,
        matched: true,
      }
    : {}
}

/** 自动值：CLI 报告的优先，其次模型目录，最后 1M / 128K */
export function autoLimits(
  model: string,
  catalog: { id: string; contextWindow?: number; maxOutput?: number }[] = [],
  opts: { entries?: ModelCatalogEntry[]; protocol?: ApiProtocol } = {},
): ResolvedLimits {
  const hit = model
    ? catalog.find((x) => x.id === model || x.id.endsWith(`/${model}`) || bare(x.id) === bare(model))
    : undefined
  if (hit?.contextWindow || hit?.maxOutput) {
    const info = modelLimitsFor(model, opts)
    return {
      context: hit.contextWindow ?? info.context,
      maxOutput: hit.maxOutput ?? info.maxOutput,
      tier: info.tier,
      efforts: info.efforts,
      defaultEffort: info.defaultEffort,
      source: 'cli',
      matched: true,
    }
  }
  const info = modelLimitsFor(model, opts)
  return {
    context: info.context,
    maxOutput: info.maxOutput,
    tier: info.tier,
    efforts: info.efforts,
    defaultEffort: info.defaultEffort,
    source: info.matched ? 'catalog' : 'default',
    matched: info.matched,
  }
}

/** 「1M」「200K」「128000」「1.05m」换成 token 数；不认识返回 undefined */
export function parseTokens(s: string): number | undefined {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(s.replace(/[,_]/g, ''))
  if (!m) return undefined
  const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'm' ? 1_000_000 : 1_000) : 1)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

/** 显示成「1M」「128K」「1.05M」，不是整千的照原样 */
export function fmtTokens(n: number) {
  if (n >= 1_000_000 && n % 10_000 === 0) return `${+(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`
  if (n === 1_048_576) return '1M'
  if (n === 65_536) return '64K'
  return String(n)
}

/** 这个 CLI 能接受哪几项：环境变量或参数里有对应的设置 */
export function limitSupport(def: CliDefinition | undefined) {
  return {
    context: !!def?.limitEnv?.context || !!def?.limitArgs?.includes('context'),
    maxOutput: !!def?.limitEnv?.maxOutput || !!def?.limitArgs?.includes('maxOutput'),
  }
}

/** 按 CLI 定义把手动设的值写成环境变量；参数由各自的 buildArgs 处理 */
export function limitEnvVars(def: CliDefinition, v: ModelLimits) {
  const out: { key: string; value: string }[] = []
  if (v.context && def.limitEnv?.context) out.push({ key: def.limitEnv.context, value: String(v.context) })
  if (v.maxOutput && def.limitEnv?.maxOutput) out.push({ key: def.limitEnv.maxOutput, value: String(v.maxOutput) })
  return out
}

export { DEFAULT_MODEL_CONTEXT, DEFAULT_MODEL_MAX_OUTPUT }
