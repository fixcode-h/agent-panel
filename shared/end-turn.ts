import type { Task, TaskMessage, ToolUse } from './schema.ts'
import type { EndTurnRecord } from './turn-end.ts'
import { PANEL_TOOL_RE, panelToolName } from './panel-tools.ts'
import { activePlan, openWork, panelWrap } from './plan.ts'

/**
 * 一轮怎么结束（设计稿 docs/openspec/changes/end-check-signal/design-v2.md）：
 * - Agent 做完了调用 end_turn（outcome: done），做不下去调用 end_turn（outcome: blocked，need 写缺什么）；
 * - 面板只认这次调用（Task.turnEnds）和工具调用记录，不读回复文字（硬规则，ADR 0041、0049）；
 * - 面板的提醒（结束前钩子拦住、一轮结束后补发）不再画进对话，只在「状态」里列出来、计次数；
 * - 提醒不限次数，只有空转保护：连续 SPIN_MAX 次提醒之间一个工具都没调，就停下来交给用户。
 * 判断和显示都用这一份，服务端的钩子、兜底提醒和界面、状态诊断口径一致
 */

export const END_TURN_TOOL = 'end_turn'

/** 连续几次提醒之间都没调工具就算空转：面板停止提醒，留警告给用户（不限制正在推进的对话） */
export const SPIN_MAX = 3

/** end_turn 的返回文字开头：界面按它分辨这次调用被拒了还是记成了卡住（面板自己写的固定标记，不是模型的文字） */
export const END_REJECTED = '【没有结束】'
export const END_BLOCKED = '【已记下卡点】'

/** 交给 Agent 的说法里，怎么结束的那一句（提醒、提示词都引用它；不翻译） */
export const END_TURN_HOW =
  '做完了就调用 end_turn（outcome: done），之后必须用一句话简短说明收尾，不要重复总结；做不下去就调用 end_turn（outcome: blocked），need 写缺什么。'

/** 没列计划时的收尾自检（用户 2026-11-05 定的说法） */
export const CHECK_REMINDER =
  '【面板】（收尾自检）这次的事做完了吗？没做完就直接调用工具接着做，不用先说明；' + END_TURN_HOW

/** 这条工具调用是不是 end_turn（各家 CLI 报上来的名字写法不同，同 fold.ts 的 wrapTool） */
export function isEndTurnTool(x: Pick<ToolUse, 'name' | 'label'>) {
  const n = panelToolName(x.name ?? '') || PANEL_TOOL_RE.exec(`${x.name ?? ''} ${x.label}`)?.[1] || ''
  return n === END_TURN_TOOL
}

/** 这次 end_turn 记成了「做完了」：没被拒、不是 blocked */
export function endTurnDone(x: Pick<ToolUse, 'name' | 'label' | 'input' | 'output' | 'failed'>) {
  if (!isEndTurnTool(x) || x.failed) return false
  const out = x.output ?? ''
  if (out.startsWith(END_REJECTED) || out.startsWith(END_BLOCKED)) return false
  return !/"outcome"\s*:\s*"blocked"/.test(x.input ?? '')
}

/** 面板的提醒：结束前钩子拦住的记录（hook）和一轮结束后补发的提醒（nudge） */
export const isReminder = (m: Pick<TaskMessage, 'panel'>) => m.panel === 'hook' || m.panel === 'nudge'

/**
 * 这一轮的起点：最近一条交给它的输入（用户、父对话、面板推回的结果）的下标。
 * 面板提醒、设置说明（note）、警告行和派出子任务的记录不算输入
 */
export function inputIndex(msgs: Pick<TaskMessage, 'role' | 'panel'>[]) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'agent' || isReminder(m)) continue
    if (m.role === 'system' && (!m.panel || m.panel === 'note')) continue
    return i
  }
  return -1
}

/** 这条输入以来 Agent 用 end_turn 交代过的结束（最近一次）；没交代过返回 undefined */
export function turnEndSince(tk: Pick<Task, 'messages' | 'turnEnds'>): EndTurnRecord | undefined {
  const i = inputIndex(tk.messages)
  const from = i >= 0 ? tk.messages[i].at : ''
  const last = tk.turnEnds?.at(-1)
  return last && last.at >= from ? last : undefined
}

/** 这条输入以来，连续几次提醒之间一个工具都没调（end_turn 不算）：到 SPIN_MAX 就是空转 */
export function idleReminders(msgs: Pick<TaskMessage, 'role' | 'panel' | 'tools'>[]) {
  let n = 0
  for (const m of msgs.slice(inputIndex(msgs) + 1)) {
    if (isReminder(m)) n++
    else if (m.role === 'agent' && m.tools.some((x) => !isEndTurnTool(x))) n = 0
  }
  return n
}

/**
 * 子对话该请收尾却还没请：计划只剩收尾那一步（别的都做完了），或者没列计划但改过文件。
 * 已经请过、已经提醒过（nudged）、被收下的不算；返回原因，不该拦返回空。只看计划和改动清单，不跑 git
 */
export function mergeOwedOf(
  tk: Pick<Task, 'parentTaskId' | 'resolved' | 'wrapRequest' | 'plans' | 'steps' | 'changes'>,
  nudged: boolean,
): string {
  if (!tk.parentTaskId || tk.resolved || tk.wrapRequest || nudged) return ''
  const plan = activePlan(tk)
  if (plan) {
    const wrapOpen = plan.steps.some((s) => panelWrap(s.wrapUp) && s.status !== 'done')
    return wrapOpen && !openWork(tk).length ? 'plan-wrap-left' : ''
  }
  return tk.changes.length ? 'changed-no-plan' : ''
}

/**
 * end_turn 能不能记下：done 时计划还有没做完的步骤、子对话改了文件没请收尾，就拒绝并说明（不算结束）。
 * 只看计划和改动清单。返回给 Agent 的文字不翻译
 */
export function endTurnCheck(
  tk: Pick<Task, 'parentTaskId' | 'resolved' | 'wrapRequest' | 'plans' | 'steps' | 'changes'>,
  outcome: string,
  need: string,
): { ok: boolean; info: string; end?: Omit<EndTurnRecord, 'at'> } {
  if (outcome !== 'done' && outcome !== 'blocked')
    return { ok: false, info: `${END_REJECTED}outcome 只能是 done（做完了）或 blocked（做不下去）` }
  if (outcome === 'blocked') {
    if (!need.trim()) return { ok: false, info: `${END_REJECTED}need 写清缺什么、需要谁做什么才能继续` }
    return {
      ok: true,
      info: `${END_BLOCKED}面板会把卡点告诉用户，等用户回复再接着做。不用再写什么，这一轮直接结束。`,
      end: { outcome, need: need.trim().slice(0, 2000) },
    }
  }
  const left = openWork(tk)
  if (left.length)
    return {
      ok: false,
      info: `${END_REJECTED}计划还有 ${left.length} 步没做完（${left
        .slice(0, 3)
        .map((s) => `「${s.title}」`)
        .join(
          '、',
        )}）：接着做，或用 set_plan 标成跳过并写明原因，再调用 end_turn；在等结果的步骤不用 end_turn，直接结束这一轮等结果推回来。`,
    }
  if (mergeOwedOf(tk, false))
    return {
      ok: false,
      info: `${END_REJECTED}你还没请父对话收尾：按「验证」跑通后调用 submit_merge，它就是这个子对话的结束，不用再调用 end_turn。`,
    }
  return { ok: true, info: '已结束这一轮：之后用一句话简短说明收尾，不要重复总结。', end: { outcome } }
}

/** 记一次结束：最近的在最后，只留最近 50 条 */
export function pushTurnEnd(tk: Pick<Task, 'turnEnds'>, end: Omit<EndTurnRecord, 'at'>, at = new Date().toISOString()) {
  tk.turnEnds = [...(tk.turnEnds ?? []).slice(-49), { ...end, at }]
}

/** 对话里被隐藏的那段文字：end_turn(done) 之后的那一次输出，原文留给「状态」里看 */
export interface HiddenText {
  id: string
  at: string
  text: string
}

/**
 * 对话里显示的消息：面板提醒不画、end_turn 这一行不画，end_turn(done) 之后的那一次输出也不画
 * （用户 2026-11-05：允许它说一句收尾，但默认隐藏，免得总结后面再跟一句「我已经完成了」）。
 * 只按位置判断（在 end_turn 之后、下一条输入之前的第一段文字），不看写了什么
 */
export function visibleMessages(msgs: TaskMessage[]): { msgs: TaskMessage[]; hidden: HiddenText[] } {
  const out: TaskMessage[] = []
  const hidden: HiddenText[] = []
  let after = false
  for (const m of msgs) {
    if (isReminder(m)) continue
    if (m.role !== 'agent') {
      if (m.role === 'user' || (m.panel && m.panel !== 'note')) after = false
      out.push(m)
      continue
    }
    const ends = m.tools.filter(isEndTurnTool)
    if (!ends.length && !after) {
      out.push(m)
      continue
    }
    // 一条消息里工具在前、文字在后（server/exec/runner.ts）：这条里有 end_turn(done)，它的文字就是之后的那次输出；
    // 这条没有文字时，下一条只有文字的消息才是。中间又动了手的，之后照常显示
    const done = ends.some(endTurnDone)
    const others = m.tools.filter((x) => !isEndTurnTool(x))
    const hide: boolean = done || (after && !others.length)
    if (hide && m.text.trim()) hidden.push({ id: m.id, at: m.at, text: m.text })
    after = hide && !m.text.trim()
    const next = { ...m, tools: others, ...(hide ? { text: '' } : {}) }
    if (next.tools.length || next.text.trim() || (!hide && next.thinking?.trim())) out.push(next)
  }
  return { msgs: out, hidden }
}

/** 「状态」里那张「面板提醒」卡片的一行 */
export interface TrailItem {
  at: string
  kind: 'hook' | 'nudge' | 'end'
  /** 交给 Agent 的提醒原文（kind 为 hook / nudge） */
  text?: string
  /** 提醒之后到下一次提醒或这一轮的下一条输入之间调了几次工具（end_turn 不算） */
  tools?: number
  outcome?: EndTurnRecord['outcome']
  need?: string
  /** end_turn(done) 之后被隐藏的那次输出 */
  hidden?: string
}

/** 按时间列出面板提醒和 Agent 的结束交代（最近的在最后），「状态」弹窗用 */
export function panelTrail(tk: Pick<Task, 'messages' | 'turnEnds'>, limit = 30): TrailItem[] {
  const items: TrailItem[] = []
  let cur: TrailItem | undefined
  for (const m of tk.messages) {
    if (isReminder(m)) {
      cur = { at: m.at, kind: m.panel === 'hook' ? 'hook' : 'nudge', text: m.text, tools: 0 }
      items.push(cur)
    } else if (m.role === 'agent') {
      if (cur) cur.tools! += m.tools.filter((x) => !isEndTurnTool(x)).length
    } else if (m.role === 'user' || (m.panel && m.panel !== 'note')) cur = undefined
  }
  const { hidden } = visibleMessages(tk.messages)
  const ends = tk.turnEnds ?? []
  ends.forEach((e, i) => {
    // 隐藏的那段在这次结束和下一次结束之间（消息的时间是开始写的时候，可能比 end_turn 早几秒，所以从上一次结束算起）
    const from = ends[i - 1]?.at ?? ''
    const to = ends[i + 1]?.at ?? '\uffff'
    const h = e.outcome === 'done' ? hidden.find((x) => x.at > from && x.at < to) : undefined
    items.push({ at: e.at, kind: 'end', outcome: e.outcome, need: e.need, hidden: h?.text })
  })
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-limit)
}
