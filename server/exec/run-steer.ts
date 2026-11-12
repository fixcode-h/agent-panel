// runAgent 里接用户补充的通道（重构文档第 3 条：按阶段拆 runAgent）。
//
// 两条路同时开：CLI 支持插话的走 register 登记的 steerer（收下就断开当前回复或等下一次请求再断开），
// 能挂面板 MCP 工具的再挂一个 taker，让模型用 read_user_notes 取。补充排在长命令后面时 checkRedirect 到点停下命令。
// 动到的共享状态：st.control / st.steerer（登记的通道）、st.steerPending / st.cutAfter（什么时候断开当前回复）、
// st.redirectTimer（停下命令的定时器）、st.cur（取走补充后另起一条）。
import type { Task, TaskMessage, ToolUse } from '../../shared/schema.ts'
import { withAttachments } from '../../shared/task.ts'
import { log } from '../log.ts'
import type { RealContext } from './real-context.ts'
import type { RunState } from './run-state.ts'
import type { CliControl } from './invoke.ts'
import { addNoteTaker, type NoteTaker } from './delivery.ts'
import { steerNote, steers } from './steering.ts'
import { REDIRECT_LIMITS, REDIRECT_NOTE, redirectWait } from './redirect.ts'

export interface SteerDeps {
  ctx: RealContext
  task: Task
  st: RunState
  step: string
  agentId: string
  /** 能用面板 MCP 工具取补充（read_user_notes） */
  canTake: boolean
  toolStart: Map<ToolUse, number>
  arm: (text?: string) => void
}

/** 建好接补充的通道；taker 在能取时就登记好，register 等 CLI 交出控制句柄时调 */
export function createSteering(d: SteerDeps) {
  const { ctx, task, st, step, agentId, canTake, toolStart, arm } = d
  /**
   * 补充排在正在执行的命令后面（Pi 要等这一批工具跑完才取）：命令跑了一会儿还没完（例如 sleep 等 CI），
   * 用户就一直等不到回应。超过阈值就停下这条命令，让 CLI 马上处理补充；
   * 只读命令等它自己跑完（这批工具结束时 CLI 就会取补充），卡住了才按更长的阈值停
   */
  const checkRedirect = () => {
    clearTimeout(st.redirectTimer)
    st.redirectTimer = undefined
    const c = st.control
    if (!st.steerPending || st.finished || !c?.redirect) return
    // 只等命令：读文件、改文件很快就完；面板自己的工具（等子任务这些）另有办法接用户的消息
    const wait = redirectWait(
      [...toolStart].map(([x, at]) => ({ kind: x.kind, label: x.label, startedAt: at })),
      Date.now(),
      REDIRECT_LIMITS,
    )
    if (wait === undefined) return
    if (wait > 0) {
      st.redirectTimer = setTimeout(checkRedirect, wait)
      st.redirectTimer.unref?.()
      return
    }
    void c
      .redirect(REDIRECT_NOTE)
      .catch((e: Error) => log.warn('task', '停下命令处理补充失败', { task: task.id, error: e.message }))
  }
  const register = (c: CliControl) => {
    st.control = c
    st.steerer = {
      step,
      agentId,
      steer: c.steer,
      accepted: (msg) => {
        // CLI 收下了补充：这一轮又在处理了；延迟取走的那些等它真正开始下一次生成再断开输出
        if (msg) steered.add(msg)
        task.working = true
        // 交出的插话也要等到模型的回应：一直没有输出时照样标成卡住、告诉用户，不让「等待模型」无声地挂着
        arm(msg?.text)
        if (c.deferSteer) {
          st.steerPending = true
          checkRedirect()
        } else st.cutAfter = true
        ctx.changed(true)
      },
    }
    ;(steers.get(task.id) ?? steers.set(task.id, new Set()).get(task.id)!).add(st.steerer)
  }
  let taker: NoteTaker | undefined
  /** 登记了、CLI 还没取走的补充：消息已经在对话里，这一轮结束前没取走的交给下一轮接着处理 */
  const pendingNotes = new Set<TaskMessage>()
  /**
   * 以插话方式交出去的补充：CLI 收下不等于模型看见了。
   * 这一轮一个字都没产出时（网关吞了、请求根本没发出去），这些消息要交给下一轮重放，
   * 否则用户的消息只留在对话里，既没有回复也没有报错。
   */
  const steered = new Set<TaskMessage>()
  // notes 与 steer 不互斥：steer 在 CLI 不在活跃轮次时返回 false，补充会丢；两个通道都开（同样见 invoke.ts）
  if (canTake) {
    taker = {
      add: (msg) => pendingNotes.add(msg),
      read: () => {
        const mine = [...pendingNotes]
        if (!mine.length) return []
        pendingNotes.clear()
        // 拿到就算交出去了：之后的输出另起一条，排在用户消息后面
        st.cur = undefined
        ctx.changed(true)
        return mine.map((m) =>
          steerNote(withAttachments(m.text, m.attachments ?? []), task.mode === 'chat', m.peer?.rel === 'parent'),
        )
      },
    }
    addNoteTaker(task.id, taker)
  }
  return { checkRedirect, register, taker, pendingNotes, steered }
}
