import { t } from '../i18n.ts'
import type { Task } from '../schema.ts'
import type { ResolvedSupport } from '../models/support.ts'
import { ideMcpLines, type IdeMcpServer } from '../mcp-catalog/code-index.ts'
import { activePlan } from '../plan/index.ts'
import { globToRegExp } from '../lessons.ts'
import { CODE_STYLE_SKILLS, codeStylePush } from '../skills/code-style.ts'
import { customToolFor, type CustomToolSig } from '../custom-tools/match.ts'
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
  /** 项目接的 JetBrains IDE MCP 服务（server/mcp-catalog/code-index.ts 的 ideMcpServersFor）；没有为空 */
  ideMcp?: IdeMcpServer[]
  /** 这个对话能用的自建工具认得出的程序名（shared/custom-tools/match.ts）；没有为空 */
  customTools?: CustomToolSig[]
}

/** 这一轮开跑时就定了的事：决定装不装钩子 */
type ActiveCtx = Pick<SituationCtx, 'support' | 'plans' | 'ideMcp' | 'customTools'>

export interface SituationalRule {
  id: string
  /** 给人看的名字（设置页、最近触发） */
  name: () => string
  when: {
    event: SituationCtx['event']
    /** 工具的类别；不写是改文件、跑命令、读文件，any 是任意工具（MCP 工具多半归在这里） */
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
  active?: (c: ActiveCtx) => boolean
  /** 额外的条件：只看面板状态 */
  need?: (c: SituationCtx) => boolean
  /** 推给模型的一段话 */
  text: (c: SituationCtx) => string
  /** 一个对话里最多推几次，默认 1 */
  times?: number
}

/** 这次调的是不是某个 IDE 服务的工具：MCP 工具名是 mcp__<服务>__<工具>，服务名里的 - 可能被 CLI 换成 _ */
function ideServerOf(c: SituationCtx): IdeMcpServer | undefined {
  const name = c.facts.tool?.name ?? ''
  if (!name.startsWith('mcp__')) return undefined
  const server = name.slice(5, name.lastIndexOf('__'))
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '_')
  return c.ideMcp?.find((s) => norm(s.server) === norm(server))
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
  {
    // JetBrains IDE 服务的调用规矩（原来常驻在「搜索」一节，code-index.ts 的 ideMcpLines）：只在第一次调它的工具时推，
    // 参数照它报的参数表生成。这次调用要是已经传错了，报错后「参数传错」提醒（arg-table-hint）会再给参数表
    id: 'ide-mcp-rules',
    name: () => t('IDE 服务的调用规矩'),
    when: { event: 'tool.before', kinds: ['any'] },
    active: (c) => !!c.ideMcp?.length,
    need: (c) => !!ideServerOf(c),
    text: (c) => {
      const s = ideServerOf(c)
      return [
        '【面板】你第一次调 JetBrains IDE 的 MCP 服务，先看一遍调用规矩（之后不再重复）：',
        ...ideMcpLines(s ? [s] : []).map((l) => l.replace(/^ {3}/, '')),
      ].join('\n')
    },
  },
  {
    // 自己拼命令跑一个自建工具已经包好的程序（用户做了 Lua 检查工具，Agent 照样自己跑 luac -p，2026-11-26）：
    // 提示词里的清单不一定被注意到，到它要跑的那一刻提醒改用 custom_tool。命令照常执行，只提醒不拦
    id: 'custom-tool-instead',
    name: () => t('改用自建工具'),
    when: { event: 'tool.before', kinds: ['shell'] },
    active: (c) => !!c.customTools?.length,
    need: (c) => !!customToolFor(String(c.facts.tool?.input.command ?? ''), c.customTools ?? []),
    text: (c) => {
      const hit = customToolFor(String(c.facts.tool?.input.command ?? ''), c.customTools ?? [])!
      return `【面板】这件事用户做成了自建工具「${hit.name}」（id ${hit.id}）：以后改用 custom_tool action=run id=${hit.id} 调它（参数不清楚先 action=show），不要自己拼命令；面板会替它校验参数、过授权、只回报错和输出尾部。`
    },
    times: 2,
  },
  // 第一次改某种语言的文件前推它的代码风格要点（shared/skills/code-style.ts）：模型常常不去读风格技能的正文，
  // 不管是父对话、子对话、工作流节点还是子任务，也不管角色点没点名这个技能，到改文件这一刻都给到
  ...CODE_STYLE_SKILLS.map((s): SituationalRule => ({
    id: `code-style:${s.skill}`,
    name: () => t('{lang} 代码风格要点', { lang: s.label }),
    when: { event: 'tool.before', kinds: ['edit'], paths: s.paths },
    text: () => codeStylePush(s),
  })),
]

// MCP 工具名是 mcp__<服务>__<工具>：按最后一段比
const toolName = (f: HookFacts) => f.tool?.panel || f.tool?.name.split('__').at(-1) || ''

/** 这一轮可能用上的规则（见 SituationalRule.active） */
export const activeSituational = (c: ActiveCtx, rules: SituationalRule[] = SITUATIONAL_RULES) =>
  rules.filter((r) => !r.active || r.active(c))

/** 这条规则在这次工具调用上对不对得上（不看推过几次） */
export function situationMatches(r: SituationalRule, c: SituationCtx): boolean {
  const w = r.when
  if (w.event !== c.event || !c.facts.tool) return false
  const tool = c.facts.tool
  if (w.kinds && !w.kinds.includes('any') && !w.kinds.includes(tool.kind)) return false
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
