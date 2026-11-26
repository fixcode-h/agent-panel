import type { Task } from '../../shared/schema.ts'
import type { HookFacts } from '../../shared/hooks/index.ts'
import type { ToolKind } from '../../shared/hooks/defs.ts'
import type { ResolvedSupport } from '../../shared/models/support.ts'
import type { IdeMcpServer } from '../../shared/mcp-catalog/code-index.ts'
import type { CustomToolSig } from '../../shared/custom-tools/match.ts'
import { activeSituational, pickSituational } from '../../shared/hooks/situational.ts'
import { taskMap } from '../runtime/task-state.ts'
import { taskLog } from '../tasks/log.ts'

/**
 * 内置钩子「情境规则」（situational-rules）：规则表在 shared/hooks/situational.ts，这里只管按对话记推过几次、
 * 记日志和设置页的「最近触发」。和推送教训一样走工具前 / 工具后补说明，只提醒不拦截
 */

/** 每个对话里每条规则推过几次 */
const told = taskMap<Map<string, number>>('hooks.situational 推过的情境规则') // 运行时（task-state 登记，对话删掉时跟着清）：重启后最多再推一次

export interface SituationalCtx {
  task: Task
  support?: ResolvedSupport
  plans: boolean
  ideMcp?: IdeMcpServer[]
  /** 这个对话能用的自建工具（认程序名用） */
  customTools?: CustomToolSig[]
  /** 一次最多推几条（按模型档位的「情境推送条数」） */
  limit: number
  note: (event: 'tool.before' | 'tool.after', detail: string) => void
}

/**
 * 这一轮的推送；一条规则都用不上时返回 undefined（调用方就不为它装钩子）。
 * kinds 是这几条规则关心的工具类别，按事件分开：能按类别过滤的 CLI 只对这几类触发
 */
export function situationalPush(c: SituationalCtx) {
  const rules = activeSituational({ support: c.support, plans: c.plans, ideMcp: c.ideMcp, customTools: c.customTools })
  if (!rules.length) return undefined
  const ALL: ToolKind[] = ['edit', 'shell', 'read']
  const kinds = (event: 'tool.before' | 'tool.after') => [
    ...new Set(rules.filter((r) => r.when.event === event).flatMap((r) => r.when.kinds ?? ALL)),
  ]
  const push = (event: 'tool.before' | 'tool.after', facts: HookFacts): string => {
    if (!facts.tool) return ''
    const mine = told.get(c.task.id) ?? new Map<string, number>()
    told.set(c.task.id, mine)
    const hits = pickSituational(
      { event, facts, task: c.task, support: c.support, plans: c.plans, ideMcp: c.ideMcp, customTools: c.customTools },
      mine,
      c.limit,
      rules,
    )
    if (!hits.length) return ''
    const text = hits.map((h) => h.text).join('\n\n')
    c.note(event, text)
    taskLog(c.task.id, '推了情境规则', { rules: hits.map((h) => h.id), tool: facts.tool.name })
    return text
  }
  return { push, before: kinds('tool.before'), after: kinds('tool.after') }
}
