/**
 * 父对话执行中收到的用户插话有没有着落（分析稿 B1，designs/Agent写代码能力-提升与扩展分析.md）。
 *
 * 为什么：#397 之后父对话拿到的插话说明写清了「是子对话的事就马上 send_to_conversation 转」，但转不转还是看模型，
 * 那次出问题的恰好是弱模型（deepseek-v4-flash）：回一句「我转给它」却没调用，用户的话一直没送到在修的子对话。
 * 这里把「有没有送到」变成面板能核对的事：名下派过子对话的父对话，执行中收到的每条用户插话都算待处理，
 * 下面任一件事发生就算处理了，否则这一轮要结束时结束前钩子问一次（只问一次）：
 * - send_to_conversation 送到了，quote 带了这条消息的 id（分诊记录 TaskRoute.quoted）；
 * - end_turn 的 own 写了这条 id：Agent 交代这是对它自己这件事的调整，不用转（EndTurnRecord.own）；
 * - 已经问过一次（结束前钩子的提醒里带着 STEER_PENDING_MARK）。
 * 只看消息的交付方式、工具调用记录和面板状态，不读回复文字（ADR 0041、0049）。交给 Agent 的话是提示词，不翻译
 */
import type { Task, TaskMessage } from '../schema.ts'
import { isReminder } from '../end-turn.ts'

/** 提醒里带的固定记号：面板按它认出「这条插话已经问过一次」，不读别的文字 */
export const STEER_PENDING_MARK = '【用户插话还没有着落】'

/** 执行中交进这一轮的方式：插话、登记给 read_user_notes 取。排到下一轮的（held / next）会作为新一轮的输入，不在这里管 */
const IN_TURN: readonly string[] = ['steer', 'notes']

/** 用户在这个对话里亲口发的（不是别的对话转来的、不是面板推的），同 quote.ts 的 ownWords */
const ownWords = (m: TaskMessage) => m.role === 'user' && !m.peer && !m.panel && !!m.text.trim()

/** 名下派过子对话的顶层对话：用户的话可能是说给某个子对话的（和 steer-note.ts 的 coordinator 同一个判断） */
export function steerCoordinator(tk: Pick<Task, 'mode' | 'parentTaskId' | 'routes'>) {
  return (
    tk.mode !== 'workflow' &&
    !tk.parentTaskId &&
    (tk.routes ?? []).some((r) => r.target === 'child' || r.target === 'resend')
  )
}

/**
 * 这一轮里还没有着落的用户插话（最早的在前）。范围从这一轮最近一条不是插话的输入算起：
 * 更早几轮的插话那时没人核对，不拿来拦现在这一轮
 */
export function pendingSteers(
  tk: Pick<Task, 'mode' | 'parentTaskId' | 'routes' | 'messages' | 'turnEnds'>,
): TaskMessage[] {
  if (!steerCoordinator(tk)) return []
  const msgs = tk.messages
  let from = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'user' && !IN_TURN.includes(m.delivery?.how ?? '')) {
      from = i
      break
    }
  }
  const quoted = new Set((tk.routes ?? []).flatMap((r) => r.quoted ?? []))
  const own = new Set((tk.turnEnds ?? []).flatMap((e) => e.own ?? []))
  const out: TaskMessage[] = []
  msgs.forEach((m, i) => {
    if (i <= from || !ownWords(m) || !IN_TURN.includes(m.delivery?.how ?? '')) return
    if (quoted.has(m.id) || own.has(m.id)) return
    const asked = msgs.slice(i + 1).some((x) => isReminder(x) && x.text.includes(STEER_PENDING_MARK))
    if (!asked) out.push(m)
  })
  return out
}

/** 结束前钩子拦住时交给父对话的话：列出那几条插话（原文开头 + id），说清两种收口办法 */
export function steerPendingBlock(list: Pick<TaskMessage, 'id' | 'text'>[]) {
  const rows = list
    .slice(0, 5)
    .map((m) => `- id ${m.id}：${m.text.trim().replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n')
  return `${STEER_PENDING_MARK}你执行中用户插了 ${list.length} 句话，面板没看到你把它们交出去：
${rows}
逐条判断：
- 是某个子对话手上的事（它的方案、修法、范围、要改的函数或文件）：现在用 send_to_conversation 交给那个子对话，quote 写这条的 id（面板把原话原样带过去），再结束这一轮；
- 是对你自己这件事的调整：调用 end_turn 时在 own 里写这条的 id。
这个提醒只出现一次，不用回复它本身。`
}

/** end_turn 的 own：按 id 认用户亲口说的话，"last" 是最近一条；认不出的丢掉（只是收口记号，不用报错） */
export function ownSteerIds(messages: TaskMessage[], ids: string[]): string[] {
  const last = [...messages].reverse().find(ownWords)?.id ?? ''
  const mine = new Set(messages.filter(ownWords).map((m) => m.id))
  return [...new Set(ids.map((x) => (x.trim() === 'last' ? last : x.trim())))].filter((x) => mine.has(x)).slice(0, 20)
}
