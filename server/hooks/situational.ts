import type { Task } from '../../shared/schema.ts'
import type { HookFacts } from '../../shared/hooks/index.ts'
import type { ToolKind } from '../../shared/hooks/defs.ts'
import type { ResolvedSupport } from '../../shared/models/support.ts'
import type { IdeMcpServer } from '../../shared/mcp-catalog/code-index.ts'
import type { CustomToolSig } from '../../shared/custom-tools/match.ts'
import type { ProgramPathView } from '../../shared/custom-tools/programs.ts'
import { activeSituational, pickSituational, type SituationCtx } from '../../shared/hooks/situational.ts'
import { skillHitCall, skillRules } from '../../shared/skills/rules.ts'
import { whenReason } from '../../shared/skills/when.ts'
import { taskMap, taskSet } from '../runtime/task-state.ts'
import { taskLog } from '../tasks/log.ts'
import { pushedSkills } from '../skills/push-ledger.ts'
import { pushSkill, repushSkills, type PushCtx } from '../skills/push.ts'

/**
 * 内置钩子「情境规则」（situational-rules）和「按情境推技能」（skill-push，ADR 0083）：规则表在 shared/hooks/situational.ts，
 * 技能规则由技能目录生成（shared/skills/rules.ts）。这里只管按对话记推过几次、读技能正文、记日志和设置页的「最近触发」。
 * 和推送教训一样走工具前 / 工具后补说明，只提醒不拦截。
 * 技能推送不受「情境推送条数」限制、不看扶持档位；同一技能推没推过看推送记录（server/skills/push-ledger.ts）
 */

/** 每个对话里每条规则推过几次 */
const told = taskMap<Map<string, number>>('hooks.situational 推过的情境规则') // 运行时（task-state 登记，对话删掉时跟着清）：重启后最多再推一次
/** 改过文件的对话（技能条件 phase: finishing-edited 用） */
const edited = taskSet('hooks.situational 改过文件的对话') // 运行时（task-state 登记）

export interface SituationalCtx {
  task: Task
  support?: ResolvedSupport
  plans: boolean
  ideMcp?: IdeMcpServer[]
  /** 这个对话能用的自建工具（认程序名用） */
  customTools?: CustomToolSig[]
  /** 这个项目登记过的程序位置（认「又在全盘找它」用） */
  programs?: ProgramPathView[]
  /** 一次最多推几条（按模型档位的「情境推送条数」）；技能不算条数 */
  limit: number
  /** 情境规则开着（内置钩子 situational-rules） */
  rules: boolean
  /** 技能推送开着时：技能目录、上限（server/skills/push.ts） */
  skills?: Omit<PushCtx, 'taskId'>
  /** 记进设置页「最近触发」：情境规则和技能推送各记在自己的内置钩子下 */
  note: (
    hook: 'situational-rules' | 'skill-push',
    event: 'tool.before' | 'tool.after' | 'context.restored',
    detail: string,
  ) => void
}

/**
 * 这一轮的推送；一条规则都用不上时返回 undefined（调用方就不为它装钩子）。
 * kinds 是这几条规则关心的工具类别，按事件分开：能按类别过滤的 CLI 只对这几类触发
 */
export function situationalPush(c: SituationalCtx) {
  const base = c.rules
    ? activeSituational({
        support: c.support,
        plans: c.plans,
        ideMcp: c.ideMcp,
        customTools: c.customTools,
        programs: c.programs,
      })
    : []
  const rules = [...base, ...(c.skills ? skillRules(c.skills.catalog) : [])]
  if (!rules.length && !c.skills) return undefined
  const ALL: ToolKind[] = ['edit', 'shell', 'read']
  const kinds = (event: 'tool.before' | 'tool.after') => [
    ...new Set(rules.filter((r) => r.when.event === event).flatMap((r) => r.when.kinds ?? ALL)),
  ]
  const push = async (event: 'tool.before' | 'tool.after', facts: HookFacts): Promise<string> => {
    if (!facts.tool) return ''
    if (event === 'tool.before' && facts.tool.kind === 'edit') edited.add(c.task.id)
    const mine = told.get(c.task.id) ?? new Map<string, number>()
    told.set(c.task.id, mine)
    const ctx: SituationCtx = {
      event,
      facts,
      task: c.task,
      support: c.support,
      plans: c.plans,
      ideMcp: c.ideMcp,
      customTools: c.customTools,
      programs: c.programs,
      edited: edited.has(c.task.id),
    }
    // 推过的技能不再参与匹配（开跑时推的、用户「/名字」点名的也算推过）
    const done = pushedSkills(c.task.id)
    const hits = pickSituational(
      ctx,
      mine,
      c.limit,
      rules.filter((r) => !r.skill || !done.has(r.skill)),
    )
    if (!hits.length) return ''
    const parts: string[] = []
    for (const h of hits) {
      if (!h.skill) {
        c.note('situational-rules', event, h.text)
        parts.push(h.text)
        continue
      }
      const s = c.skills?.catalog.find((x) => x.name === h.skill)
      const w = s && skillHitCall(s, ctx)
      if (!s || !w) continue
      const text = await pushSkill({ ...c.skills!, taskId: c.task.id }, s.name, whenReason(w), `${w.kind} ${w.value}`)
      if (!text) continue
      c.note('skill-push', event, text.slice(0, 300))
      parts.push(text)
    }
    if (!parts.length) return ''
    const text = parts.join('\n\n')
    taskLog(c.task.id, '推了情境规则', { rules: hits.map((h) => h.id), tool: facts.tool.name, chars: text.length })
    return text
  }
  /** 上下文压缩后：推过的技能再推一次 */
  const restored = async (): Promise<string> => {
    if (!c.skills) return ''
    const text = await repushSkills(c.task.id)
    if (text) {
      c.note('skill-push', 'context.restored', text.slice(0, 300))
      taskLog(c.task.id, '压缩后补推技能', { chars: text.length })
    }
    return text
  }
  return { push, restored, before: kinds('tool.before'), after: kinds('tool.after') }
}
