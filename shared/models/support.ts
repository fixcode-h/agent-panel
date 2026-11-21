import { z } from 'zod'
import { t } from '../i18n.ts'
import type { ModelTier } from '../clis.ts'
import { HOOK_TIERS, type HookTier } from '../hooks/builtins.ts'

/**
 * 按模型档位加强扶持（设计稿 designs/Agent写代码能力-提升与扩展分析.md 的 C1）：
 * 同一套提示词和钩子，对强模型够用，对 deepseek-flash 这类弱模型不够。以前只能让用户自己记得「换了弱模型去开严格档」，
 * 现在按这一轮实际用的模型在模型目录里的档位（catalog.json 的 tier）自动套用一档扶持。
 *
 * 一项扶持一行（注册表），主流程只按 key 取值、不按模型名写分支。规则只「加强」不「减弱」：
 * 每一项和设置里原来的值取更强的那个（钩子档位取更严、推送条数取更多、提醒阈值取更小），
 * 所以项目里手动选的钩子档位、钩子页逐个改过的开关照旧优先，这里只在它们之上往严里推。
 */

export const SUPPORT_KEYS = ['hookTier', 'implPlan', 'pushItems', 'paceCalls'] as const
export type SupportKey = (typeof SUPPORT_KEYS)[number]
export type SupportValue = string | number

/** 写代码前要不要先有实现计划：multi = 3 步以上才进 set_plan（角色设定里原来的规矩），always = 不论几步都先进 set_plan */
export const IMPL_PLAN_MODES = ['multi', 'always'] as const
export type ImplPlanMode = (typeof IMPL_PLAN_MODES)[number]

export interface SupportItem {
  key: SupportKey
  label: () => string
  hint: () => string
  kind: 'choice' | 'number'
  /** kind 为 choice 时的选项（从弱到强排） */
  choices?: { id: string; label: () => string }[]
  min?: number
  max?: number
  /** 没有扶持时面板原来的值：比它强才算「加强了」，会话栏据此写「已按弱模型加强扶持」 */
  base: SupportValue
  /** 每一档默认开到哪 */
  defaults: Record<ModelTier, SupportValue>
  /** a 比 b 强 */
  stronger: (a: SupportValue, b: SupportValue) => boolean
}

const hookRank = (v: SupportValue) => HOOK_TIERS.indexOf(v as HookTier)
const planRank = (v: SupportValue) => IMPL_PLAN_MODES.indexOf(v as ImplPlanMode)

export const SUPPORT_ITEMS: SupportItem[] = [
  {
    key: 'hookTier',
    label: () => t('钩子档位'),
    hint: () => t('和全局档位取更严的；项目里单独选了档位时以项目为准，钩子页逐个改过的开关也照旧优先'),
    kind: 'choice',
    choices: [
      { id: 'minimal', label: () => t('精简') },
      { id: 'standard', label: () => t('标准') },
      { id: 'strict', label: () => t('严格') },
    ],
    base: 'standard',
    defaults: { low: 'strict', medium: 'standard', high: 'standard' },
    stronger: (a, b) => hookRank(a) > hookRank(b),
  },
  {
    key: 'implPlan',
    label: () => t('先列实现计划'),
    hint: () => t('「每次都要」时，第一次改文件前还没有计划，面板推一句让它先用 set_plan 列实现计划（只提醒，不拦）'),
    kind: 'choice',
    choices: [
      { id: 'multi', label: () => t('3 步以上') },
      { id: 'always', label: () => t('每次都要') },
    ],
    base: 'multi',
    defaults: { low: 'always', medium: 'multi', high: 'multi' },
    stronger: (a, b) => planRank(a) > planRank(b),
  },
  {
    key: 'pushItems',
    label: () => t('情境推送条数'),
    hint: () => t('跑命令、改文件、报错时一次最多推几条教训、经验和情境规则；和面板默认的 3 条取多的'),
    kind: 'number',
    min: 1,
    max: 8,
    base: 3,
    defaults: { low: 5, medium: 3, high: 3 },
    stronger: (a, b) => Number(a) > Number(b),
  },
  {
    key: 'paceCalls',
    label: () => t('计划没跟上的阈值'),
    hint: () => t('进行中的那一步改文件、跑命令几次还没更新就提醒；和钩子「计划没跟上提醒」的参数取小的'),
    kind: 'number',
    min: 1,
    max: 100,
    base: 20,
    defaults: { low: 10, medium: 20, high: 20 },
    stronger: (a, b) => Number(a) < Number(b),
  },
]

/**
 * 档位名单独写一份，不从 catalog.ts 取：hooks/defs.ts 引用这里，契约探查（e2e 17）用纯 node 加载，
 * catalog.ts 会连带 import catalog.json，纯 node 没有 import 属性就报错
 */
export const SUPPORT_TIERS = ['high', 'medium', 'low'] as const satisfies readonly ModelTier[]
const ModelTierName = z.enum(SUPPORT_TIERS)

/** 存在 hooks.json 里：总开关，和用户按档位改过的值（没改过的不记，取 defaults） */
export const ModelSupportData = z.object({
  enabled: z.boolean().default(true),
  values: z.partialRecord(ModelTierName, z.record(z.string(), z.union([z.string(), z.number()]))).default({}),
})
export type ModelSupportData = z.infer<typeof ModelSupportData>

/** 这一轮实际套用的扶持 */
export interface ResolvedSupport {
  tier: ModelTier
  /** 模型目录里认不出这个模型时按中档，界面上写「没认出」 */
  matched: boolean
  enabled: boolean
  hookTier: HookTier
  implPlan: ImplPlanMode
  pushItems: number
  paceCalls: number
  /** 比面板原来的值强的几项：非空时会话栏写「已按弱模型加强扶持」 */
  boosted: SupportKey[]
}

const item = (key: SupportKey) => SUPPORT_ITEMS.find((x) => x.key === key)!

/** 一个值在这一项里合不合法（设置页写入、读旧数据都按它挡） */
export function validSupportValue(key: SupportKey, v: unknown): v is SupportValue {
  const it = SUPPORT_ITEMS.find((x) => x.key === key)
  if (!it) return false
  if (it.kind === 'choice') return typeof v === 'string' && !!it.choices?.some((c) => c.id === v)
  return typeof v === 'number' && Number.isInteger(v) && v >= (it.min ?? 1) && v <= (it.max ?? 100)
}

/** 这一档这一项的值：用户改过的，没改过用默认 */
export function supportValue(data: ModelSupportData | undefined, tier: ModelTier, key: SupportKey): SupportValue {
  const v = data?.values[tier]?.[key]
  return validSupportValue(key, v) ? v : item(key).defaults[tier]
}

/** 按这一轮的模型档位算出要套用的扶持；关掉总开关时每项都是面板原来的值 */
export function resolveSupport(data: ModelSupportData | undefined, tier: ModelTier, matched = true): ResolvedSupport {
  const enabled = data?.enabled ?? true
  const get = (key: SupportKey) => (enabled ? supportValue(data, tier, key) : item(key).base)
  const boosted = SUPPORT_ITEMS.filter((it) => it.stronger(get(it.key), it.base)).map((it) => it.key)
  return {
    tier,
    matched,
    enabled,
    hookTier: get('hookTier') as HookTier,
    implPlan: get('implPlan') as ImplPlanMode,
    pushItems: Number(get('pushItems')),
    paceCalls: Number(get('paceCalls')),
    boosted,
  }
}

/** 档位的名字：会话栏「已按弱模型加强扶持」、设置页表头用 */
export const supportTierLabel = (tier: ModelTier) => ({ low: t('弱'), medium: t('中'), high: t('强') })[tier]

/** 一项扶持的值写成给人看的字 */
export function supportValueText(key: SupportKey, v: SupportValue): string {
  const it = item(key)
  if (it.kind === 'choice') return it.choices?.find((c) => c.id === v)?.label() ?? String(v)
  return key === 'pushItems' ? t('{n} 条', { n: v }) : t('{n} 次', { n: v })
}

/** 设置页改一项：enabled 改总开关；tier + key 改一格，value 为 null 或等于默认值时去掉（默认值以后改了能跟着走） */
export interface SupportPatch {
  enabled?: boolean
  tier?: ModelTier
  key?: SupportKey
  value?: SupportValue | null
}

/** 按设置页的改动算出新的数据；值不合法时返回错误说明（服务端、演示后端共用） */
export function patchSupport(
  data: ModelSupportData,
  p: SupportPatch,
): { ok: true; data: ModelSupportData } | { ok: false; error: string } {
  const next: ModelSupportData = {
    enabled: p.enabled ?? data.enabled,
    values: Object.fromEntries(Object.entries(data.values).map(([k, v]) => [k, { ...v }])),
  }
  if (p.tier && p.key) {
    const it = SUPPORT_ITEMS.find((x) => x.key === p.key)
    if (!it) return { ok: false, error: t('没有这一项扶持') }
    const mine = { ...(next.values[p.tier] ?? {}) }
    if (p.value === null || p.value === undefined || p.value === it.defaults[p.tier]) delete mine[p.key]
    else if (!validSupportValue(p.key, p.value))
      return {
        ok: false,
        error:
          it.kind === 'number'
            ? t('要是 {min} 到 {max} 之间的整数', { min: it.min ?? 1, max: it.max ?? 100 })
            : t('参数不对'),
      }
    else mine[p.key] = p.value
    if (Object.keys(mine).length) next.values[p.tier] = mine
    else delete next.values[p.tier]
  }
  return { ok: true, data: next }
}

/** 设置页看到的样子：每一项、每一档现在的值和默认值 */
export function supportView(data: ModelSupportData | undefined) {
  return {
    enabled: data?.enabled ?? true,
    items: SUPPORT_ITEMS.map((it) => ({
      key: it.key,
      label: it.label(),
      hint: it.hint(),
      kind: it.kind,
      choices: it.choices?.map((c) => ({ id: c.id, label: c.label() })),
      min: it.min,
      max: it.max,
      values: Object.fromEntries(SUPPORT_TIERS.map((tier) => [tier, supportValue(data, tier, it.key)])) as Record<
        ModelTier,
        SupportValue
      >,
      defaults: it.defaults,
    })),
  }
}

/** 记进会话用量的那一份：加强了哪几项、各是多少（会话栏照着列出来）；没加强时为 undefined */
export function supportRecord(s: ResolvedSupport) {
  if (!s.boosted.length) return undefined
  return { tier: s.tier, boosted: s.boosted.map((key) => ({ key, value: s[key] as SupportValue })) }
}
