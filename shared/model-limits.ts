/**
 * 模型的上下文窗口和最大输出（token）。设置里三档模型的这两项默认按模型自动填：
 * 先用 CLI 读模型列表时给出的（Pi、Command Code 会报），再查下面的内置表；都没有就留空，算「自动」。
 * 内置表按模型名匹配（去掉 provider/ 前缀），只收能查到官方数字的，查不到的宁可留空。
 */
import type { CliDefinition } from './clis.ts'

export interface ModelLimits {
  context?: number
  maxOutput?: number
}

const K = 1_000
const M = 1_000_000

/** 从上往下找第一条对上的，具体的写在前面 */
const KNOWN: [RegExp, ModelLimits][] = [
  // Claude 5 系列：1M 上下文、128K 输出（platform.claude.com 的模型总览）
  [/^claude-(fable|opus|sonnet|haiku)-5/, { context: M, maxOutput: 128 * K }],
  [/^claude-opus-4-[6-9]/, { context: M, maxOutput: 128 * K }],
  [/^claude-sonnet-4-6/, { context: M, maxOutput: 64 * K }],
  [/^claude-(opus|sonnet|haiku)-4/, { context: 200 * K, maxOutput: 64 * K }],
  [/^claude-3-7-sonnet/, { context: 200 * K, maxOutput: 64 * K }],
  [/^claude-3/, { context: 200 * K, maxOutput: 8 * K }],
  // Claude Code 的别名和带 [1m] 的写法
  [/\[1m\]$/, { context: M }],
  [/^(opus|sonnet|haiku|fable)$/, { context: M, maxOutput: 128 * K }],
  // OpenAI GPT-5 系列：400K 上下文、128K 输出
  [/^gpt-5/, { context: 400 * K, maxOutput: 128 * K }],
  [/^gpt-4\.1/, { context: 1_047_576, maxOutput: 32_768 }],
  [/^(o3|o4-mini)/, { context: 200 * K, maxOutput: 100 * K }],
  // Gemini 2.5 / 3：1M 上下文、64K 输出
  [/^gemini-(2\.5|3)/, { context: 1_048_576, maxOutput: 65_536 }],
]

const bare = (model: string) => model.slice(model.lastIndexOf('/') + 1).toLowerCase()

/** 内置表里的数值；不认识的模型返回空对象 */
export function knownLimits(model: string): ModelLimits {
  if (!model) return {}
  const id = bare(model)
  return KNOWN.find(([re]) => re.test(id))?.[1] ?? {}
}

/** 自动值：CLI 报告的优先，其次内置表 */
export function autoLimits(
  model: string,
  catalog: { id: string; contextWindow?: number; maxOutput?: number }[] = [],
): ModelLimits {
  const hit = model ? catalog.find((x) => x.id === model || x.id.endsWith(`/${model}`)) : undefined
  const known = knownLimits(model)
  return { context: hit?.contextWindow ?? known.context, maxOutput: hit?.maxOutput ?? known.maxOutput }
}

/** 「1M」「200K」「128000」「1.05m」换成 token 数；不认识返回 undefined */
export function parseTokens(s: string): number | undefined {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(s.replace(/[,_]/g, ''))
  if (!m) return undefined
  const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'm' ? M : K) : 1)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

/** 显示成「1M」「128K」「1.05M」，不是整千的照原样 */
export function fmtTokens(n: number) {
  if (n >= M && n % (10 * K) === 0) return `${+(n / M).toFixed(2)}M`
  if (n >= K && n % K === 0) return `${n / K}K`
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
