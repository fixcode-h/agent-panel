/**
 * 执行中的补充（插话）和等下一句的交付：正在跑的调用登记成 Steerer，用户补充按 CLI 的能力插话、
 * 登记给 read_user_notes 或留给下一个节点；停在等下一句的进程由 deliverWait 交消息。从 runner.ts 拆出
 */
import type { Attachment, Task, TaskMessage } from '../../shared/schema.ts'
import { type Waiter, addWaiter, firstWaiter, removeWaiter, waitersOf } from './waiters.ts'
import { hasHeld, heldMessage, markHeld, noteTakersOf, returnHeld, takeHeld } from './delivery.ts'
import { promptLangReminder } from '../../shared/prompt-lang.ts'
import { taskLog } from '../task-log.ts'
import { withAttachments } from '../../shared/task.ts'

/** 正在跑的一次 CLI 调用里能接收补充的那个：step 为空是对话，否则是工作流节点 */
export interface Steerer {
  step: string
  agentId: string
  steer: (text: string) => Promise<boolean>
  /**
   * 补充交给了它：之后的输出另起一条，排在用户消息后面。
   * msg 是交出去的那条用户消息，这一轮最后没有任何输出时要靠它把消息捡回来重放
   */
  accepted: (msg?: TaskMessage) => void
}
/** 任务 id → 正在跑、能接收补充的调用（工作流里同时执行的节点可能有几个） */
export const steers = new Map<string, Set<Steerer>>() // 模块状态：会话，跟着进程或连接一起没
/** 工作流里正在跑的节点都收不了补充（Command Code）时，留给下一个开始的节点 */
export const notes = new Map<string, string[]>() // 模块状态：运行时，留给下一个节点的补充，重启后丢失

/**
 * 把用户消息交给正在等下一句的 CLI。
 * 没有在等时返回 none；等着的进程已经不是输入框里的选择时返回 stale，
 * 调用方等它退出后按新的选择重新开始，不能把消息交给旧 CLI。
 */
export function deliverWait(
  task: Task,
  msg: TaskMessage,
  placed?: Attachment[],
  recorded = false,
): 'ok' | 'stale' | 'none' {
  const w = firstWaiter(task.id)
  if (!w) return 'none'
  if (!w.current()) {
    w.cancel()
    return 'stale'
  }
  w.deliver(msg, placed, recorded)
  return 'ok'
}

/**
 * CLI 刚停到等下一句上：这一轮里没交出去、排着「这一轮结束后处理」的消息直接交给它。
 * 排着的消息原本要等整次执行结束才接着处理，可保活的进程不会结束——这一轮刚说完、还没停稳时到的
 * 后台命令结果、子对话回报、用户的话就一直排着，对话收不到（用户报过：后台命令结果没回来，对话一直卡着）
 */
export function flushHeld(task: Task) {
  if (!hasHeld(task.id)) return
  const q = takeHeld(task.id)!
  markHeld(task.messages, [q], 'wait')
  const { msg, recorded, placed } = heldMessage(task.messages, q, task.placedAttachments)
  const got = deliverWait(task, msg, placed, recorded)
  // 交不出去（进程已经换了一套 CLI）：原样放回去，由整次执行结束后接着处理
  if (got !== 'ok') returnHeld(task.id, q)
}

/** 对话派出的子任务（不是工作流节点） */
const isHelperStep = (task: Task, id: string) => {
  const s = id ? task.steps.find((x) => x.id === id) : undefined
  return !!s && s.slot === 'sub'
}

/**
 * 对话停下等子任务时（回复完 CLI 就退出的，Claude Code、Codex），等用户的下一条消息：
 * 消息记进对话，交给引擎马上开一轮回复。停止、页面离开时返回 null，引擎只等子任务
 */
export function waitChat(task: Task, signal: AbortSignal, changed: (flush?: boolean) => void): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      removeWaiter(task.id, w)
      resolve(value)
    }
    const onAbort = () => done(null)
    taskLog(task.id, '等子任务期间等用户消息')
    const w: Waiter = {
      deliver: (msg, placed, recorded) => {
        taskLog(task.id, '消息交给等子任务的对话', { messageId: msg.id, recorded: recorded || undefined })
        if (!recorded) task.messages.push(msg)
        task.working = true
        changed(true)
        done(withAttachments(msg.text, placed ?? msg.attachments ?? []))
      },
      cancel: () => done(null),
      // 进程已经退出了，下一轮按输入框里现在的选择开
      current: () => true,
    }
    addWaiter(task.id, w)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 用户离开了这个对话：让还在等下一句的 CLI 结束这一轮；返回有没有真的取消到 */
export function cancelWait(taskId: string) {
  let canceled = false
  for (const w of waitersOf(taskId)) {
    w.cancel()
    canceled = true
  }
  if (canceled) taskLog(taskId, '取消等下一句')
  return canceled
}

/** 任务删掉了：还没被节点取走的补充也一起清掉，别一直留在内存里 */
export function forgetNotes(taskId: string) {
  notes.delete(taskId)
}

/**
 * 交给 CLI 的补充。对话里先让模型判断这条补充和当前任务的关系：
 * 相关就调整方向；无关就先做完手上的事，再处理这条，别把当前任务丢在半路。
 * 工作流里交给正在跑的节点，按原来的说法结合当前任务处理。
 * fromParent：父对话 / 面板发来的（状态询问、收尾提醒），不是用户补充；用「用户补充」的措辞会让模型
 * 把它当成无关信息先放着，子对话就不会回答状态询问了。
 */
export const steerNote = (text: string, chat: boolean, fromParent = false) => {
  // 补充是一条新的用户消息，重复一次语言要求，别让模型接着上一段换成别的语言
  const remind = promptLangReminder()
  if (fromParent)
    return (
      '父对话 / 面板在你执行中发来一条消息（不是用户发的补充）：\n' +
      '- 和当前任务有关（状态询问、交代任务、调整方向）：按它处理并回复；\n' +
      '- 无关：先简短说明会等当前任务完成后再处理，然后继续手上的事。\n\n' +
      `${remind}\n\n内容：\n${text}`
    )
  return chat
    ? '用户在你执行中补充了信息。先判断它和当前任务的关系：\n' +
        '- 相关（对当前任务的调整、修改或补充）：按它调整方向，继续当前任务；\n' +
        '- 无关：先简短说明会等当前任务完成后再处理，然后继续手上的事，不要现在开始做它；当前任务做完后再处理这条内容。\n\n' +
        `${remind}\n\n补充的内容：\n${text}`
    : `用户在执行中补充了信息，请结合它继续当前的任务：\n${remind}\n\n${text}`
}

/**
 * 执行中的补充：把信息交给正在跑的调用，CLI 在当前这一轮里接着处理。
 * 有插话协议的直接插话；没有协议但能用面板的工具取的（见 CLI 配置的 notes）登记给它取；
 * 工作流里交给所有正在跑的节点，它们都不支持（Command Code）时留给下一个开始的节点。
 * 消息在每一种情况下都立刻记进对话，让用户看得到；任务没在跑时返回 false，由调用方记进对话并等这一轮结束。
 */
export async function steerTask(
  task: Task,
  text: string,
  msg: TaskMessage,
): Promise<'steer' | 'notes' | 'next-node' | false> {
  // 对话里派出的子任务也登记了插话：用户的话是说给对话的，不交给它们（交过去会记在子任务名下，对话里看不到）
  const all = [...(steers.get(task.id) ?? [])].filter((s) => !(task.mode === 'chat' && isHelperStep(task, s.step)))
  const took: Steerer[] = []
  for (const s of all)
    if (await s.steer(steerNote(text, task.mode === 'chat', msg.peer?.rel === 'parent'))) took.push(s)
  if (took.length) {
    // 工作流里的补充记在节点上：不算任务的新要求（继续执行时不会把它当成要求重跑）
    const at = took[0]
    task.messages.push({ ...msg, step: at.step, agentId: at.step ? at.agentId : msg.agentId })
    for (const s of took) s.accepted(msg)
    return 'steer'
  }
  const takers = noteTakersOf(task.id)
  if (takers?.size) {
    // 对话的 CLI 没有插话协议：登记给正在跑的它，下一次调用 read_user_notes 时交给模型；
    // 这一轮结束还没取走的，由 runner 交给下一轮接着处理
    task.messages.push(msg)
    for (const k of takers) k.add(msg)
    return 'notes'
  }
  // 主 Agent 在调度（评估、整理结果）时也算工作流在跑：补充留给下一个开始的调用
  const running = task.steps.find((x) => x.status === 'running' && !x.parentId)
  if (!(task.mode === 'workflow' && running)) return false
  ;(notes.get(task.id) ?? notes.set(task.id, []).get(task.id)!).push(text)
  task.messages.push({ ...msg, step: running.id, agentId: msg.agentId })
  return 'next-node'
}
