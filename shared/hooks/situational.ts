import { t } from '../i18n.ts'
import type { Task } from '../schema.ts'
import type { ResolvedSupport } from '../models/support.ts'
import { activePlan } from '../plan/index.ts'
import { globToRegExp } from '../lessons.ts'
import type { ToolKind } from './defs.ts'
import type { HookFacts } from './index.ts'

/**
 * 情境规则（设计稿 designs/Agent写代码能力-提升与扩展分析.md 的 D1）：只在某个情境才用得上的细则，不再常驻在角色设定里，
 * 由面板在那一刻（第一次调某类工具前、改某类文件前、报了某类错之后）推给模型。基础提示词只留一行原则，
 * 新规则加成这里的一行，主流程（server/hooks/situational.ts）只按表匹配，不按规则名写分支。
 *
 * 只看工具调用和面板状态（计划、这一轮的扶持档位），不看回复文字（ADR 0041、0049）；只提醒不拦截。
 * 推给模型的文字是提示词，不翻译；name 是设置页和「最近触发」里给人看的，要翻译
 */

export interface SituationCtx {
  event: 'tool.before' | 'tool.after'
  facts: HookFacts
  task: Pick<Task, 'plans'>
  /** 这一轮按模型档位套用的扶持；没算出来（老调用方）时为空 */
  support?: ResolvedSupport
  /** 这个对话有计划工具（set_plan）：只给这样的对话推和计划有关的规则 */
  plans: boolean
}

export interface SituationalRule {
  id: string
  /** 给人看的名字（设置页、最近触发） */
  name: () => string
  when: {
    event: SituationCtx['event']
    /** 工具的类别；不写是任意类别 */
    kinds?: ToolKind[]
    /** 工具名（去掉 MCP 前缀后的）匹配；不写不限 */
    tool?: RegExp
    /** 要改、要读的文件（相对项目根）对得上其中一条通配才推；不写不限 */
    paths?: string[]
    /** 只在工具失败之后（tool.after）推；报错原文还要对得上 error 才推 */
    failed?: boolean
    error?: RegExp
  }
  /**
   * 这一轮有没有可能用上（只看这一轮开跑时就定了的事：扶持档位、有没有计划工具）：一条都用不上时不装钩子，
   * 普通对话每次工具调用不多问一次面板。不写是一直可能
   */
  active?: (c: Pick<SituationCtx, 'support' | 'plans'>) => boolean
  /** 额外的条件：只看面板状态 */
  need?: (c: SituationCtx) => boolean
  /** 推给模型的一段话 */
  text: (c: SituationCtx) => string
  /** 一个对话里最多推几次，默认 1 */
  times?: number
}

export const SITUATIONAL_RULES: SituationalRule[] = [
  {
    // 弱模型常常不列计划就直接开改，改到一半验收标准被默默放宽（C1：弱档「先列实现计划」= 每次都要）
    id: 'impl-plan-first',
    name: () => t('先列实现计划'),
    when: { event: 'tool.before', kinds: ['edit'] },
    active: (c) => c.plans && c.support?.implPlan === 'always',
    need: (c) => !activePlan(c.task),
    text: () =>
      '【面板】你要开始改文件了，但这个对话还没有计划。这一轮的模型按弱档加强扶持：不论几步，写代码前都先用 set_plan 列出实现计划（目标与验收、要改的文件、每步改完跑什么验证），再接着改。',
  },
]

// MCP 工具名是 mcp__<服务>__<工具>：按最后一段比
const toolName = (f: HookFacts) => f.tool?.panel || f.tool?.name.split('__').at(-1) || ''

/** 这一轮可能用上的规则（见 SituationalRule.active） */
export const activeSituational = (
  c: Pick<SituationCtx, 'support' | 'plans'>,
  rules: SituationalRule[] = SITUATIONAL_RULES,
) => rules.filter((r) => !r.active || r.active(c))

/** 这条规则在这次工具调用上对不对得上（不看推过几次） */
export function situationMatches(r: SituationalRule, c: SituationCtx): boolean {
  const w = r.when
  if (w.event !== c.event || !c.facts.tool) return false
  const tool = c.facts.tool
  if (w.kinds && !w.kinds.includes(tool.kind)) return false
  if (w.tool && !w.tool.test(toolName(c.facts))) return false
  if (w.paths) {
    const files = tool.paths.length ? tool.paths : [tool.path]
    const res = w.paths.map((g) => globToRegExp(g))
    if (!files.some((p) => p && res.some((re) => re.test(p.replace(/\\/g, '/'))))) return false
  }
  if (w.failed) {
    if (c.event !== 'tool.after' || !tool.result?.failed) return false
    if (w.error && !w.error.test(tool.result.output)) return false
  }
  if (r.active && !r.active(c)) return false
  return r.need ? r.need(c) : true
}

/**
 * 这次该推的规则：对得上、还没推够次数的，最多 limit 条。told 记着每条推过几次（调用方按对话保存），这里会更新它
 */
export function pickSituational(
  c: SituationCtx,
  told: Map<string, number>,
  limit: number,
  rules: SituationalRule[] = SITUATIONAL_RULES,
): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = []
  for (const r of rules) {
    if (out.length >= Math.max(1, limit)) break
    const n = told.get(r.id) ?? 0
    if (n >= (r.times ?? 1) || !situationMatches(r, c)) continue
    told.set(r.id, n + 1)
    out.push({ id: r.id, text: r.text(c) })
  }
  return out
}
