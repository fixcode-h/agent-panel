// runAgent 停下等下一句 / 等子任务的那一段（重构文档第 3 条：按阶段拆 runAgent）。
//
// 两条路：模型自己调 wait_user_message（waitUser），面板在一轮结束后保活（keepAlive）。
// 动到的共享状态：st.waitingHelpers / st.toolWaited / st.fromUser（等的是什么、等到的是谁的话），
// 等到消息后 st.cur 置空（之后的输出另起一条）、st.prewarmMode 关掉、st.turnMark 和 st.turnEnded 重新开始一段。
import type { Task, TaskMessage } from '../../shared/schema.ts'
import type { CliDefinition } from '../../shared/clis.ts'
import { helperGate } from '../../shared/engine.ts'
import type { AgentCall } from '../../shared/engine/host.ts'
import { pauseRun, resumeRun, withAttachments } from '../../shared/task.ts'
import { sourceHeader } from '../../shared/peer-message.ts'
import { log } from '../log.ts'
import { taskLog } from '../tasks/log.ts'
import { hasViewer, isWatched } from '../presence.ts'
import type { RealContext } from './real-context.ts'
import type { RunState } from './run-state.ts'
import { addWaiter, removeWaiter, userWaitSlot, type Waiter } from './waiters.ts'
import { flushHeld } from './steering.ts'
import { apiSlots, slotKey, takeApiSlot } from './api-gate.ts'
import { isNetError } from './retry-policy.ts'
import { bugSlash } from './bug-prompt.ts'
import type { composeInput } from './compose-input.ts'

/** 等待要用到的：这次调用的身份、共享状态和 runAgent 里的几个帮手 */
export interface WaitDeps {
  ctx: RealContext
  call: AgentCall
  task: Task
  st: RunState
  def: CliDefinition
  step: string
  chat: boolean
  op: AgentCall['op']
  orch: Awaited<ReturnType<typeof composeInput>>['orch']
  /** 能用面板 MCP 工具等下一句（模型自己调 wait_user_message） */
  canTake: boolean
  /** 回复完能把进程留着等下一句（面板保活） */
  canWait: boolean
  mine: TaskMessage[]
  touched: Set<string>
  pendingNotes: Set<TaskMessage>
  arm: (text?: string) => void
  emptyTurn: () => boolean
  endTurn: () => void
  openChanges: (carry: boolean) => void
  stillCurrent: () => boolean
  tellNoEffort: () => void
}

/** 建好两条等待的入口：交给 invokeCli 的 waitUser 和 keepAlive（这个 CLI / 这次调用用不上的是 undefined） */
export function createWaiting(d: WaitDeps) {
  const { ctx, call, task, st, def, step, chat, op, orch, canTake, canWait } = d
  const { mine, touched, pendingNotes, arm, emptyTurn, endTurn, openChanges, stillCurrent, tellNoEffort } = d
  // 这次调用里的「等下一句」：用户的下一句直接交回这个进程，不用 --resume；新挂上的换下还挂着的旧的
  const userWait = userWaitSlot(task.id)
  // 这一轮派出的子任务：对话停在面板的等待工具上等它们，等的时候用户照样能聊（见 helperGate）
  const gate =
    chat && orch
      ? helperGate(
          () => orch.helperBatch(),
          async (text) => {
            const s = st.steerer
            if (!s || !(await s.steer(text))) return false
            s.accepted()
            return true
          },
        )
      : undefined
  /**
   * 停下等下一句 / 等子任务（fromTool：模型正在调 wait_user_message；否则是面板在这一轮结束后保活）：
   * 这段不用模型，让出 API 名额；拿到要处理的内容后先拿回名额再交给 CLI，
   * 满了就排队（对话上显示在等哪个 API），排队时停止就结束这一轮
   */
  const waitNext = async (fromTool: boolean): Promise<string | null> => {
    const slot = apiSlots.get(slotKey(task.id, step))
    // 让出前手里有没有名额，决定拿回时是哪种排队：
    // 持有过 = 这一轮已经跑起来、临时让出（yield，不显示成排队）；
    // 没持有过 = 预热（prewarm）对话等第一句，这一轮从没出过 token，此刻排队就是真的还没开始（start）
    const yielded = !!slot?.holding
    slot?.drop()
    const text = await waitNextRaw(fromTool)
    if (text === null || !slot) return text
    return (await takeApiSlot(ctx, call.step, slot, ctx.signal, yielded ? 'yield' : 'start')) ? text : null
  }
  const waitNextRaw = async (fromTool: boolean): Promise<string | null> => {
    if (fromTool) {
      if (st.finished) return null
      st.toolWaited = true
    }
    // 这一轮派出的子任务还没交回：对话停在这里等它们做完，结果交回同一个进程接着做；
    // 等的时候用户发来的消息马上交给 CLI 回复，不用等子任务
    const back = gate?.wait(ctx.signal, (signal) => listen(signal, true))
    if (back) {
      const text = await back
      if (!text || ctx.signal.aborted) return null
      // 子任务的结果到了、接着干：从这一刻继续算执行
      resumeRun(task)
      // 交回的结果会让 CLI 接着做，这一段的结束要照常上报：result 之后停在这里等子任务时
      // 这一轮已经标记过结束了（见 endTurn），不复位会吞掉交回后那次结束
      st.turnEnded = false
      openChanges(true)
      // 之后的输出另起一条，排在交回的结果后面
      st.cur = undefined
      task.working = true
      arm(text)
      ctx.changed(true)
      return text
    }
    // 用户在这一轮执行中换了 CLI/模型/强度：旧进程不要再等下一句，结束后按新的选择重开
    if (chat && !stillCurrent()) return null
    // 这一轮没取走的补充：不再挂着等下一句，直接结束这一轮，由调用方马上开始新一轮接着处理
    if (pendingNotes.size) return null
    return listen(ctx.signal, false)
  }
  /**
   * 停在等待上，等用户的下一条消息。helpers：其实在等子任务，这一轮没做完，
   * 不算回复完成，也不因为页面离开就结束（子任务的结果还要交回这个进程）
   */
  const listen = async (signal: AbortSignal, helpers: boolean): Promise<string | null> => {
    if (signal.aborted) return null
    task.prewarming = false
    // 等子任务时页面显示「等待 n 个子任务完成」，不是「等待你的下一条消息」
    if (helpers) st.waitingHelpers = true
    else {
      task.awaitingUser = true
      // 进保活前先让宿主按全局上限收一批最久没用的
      ctx.onKeepAlive?.(task.id)
    }
    // 停在等待上：这一段不算执行。等用户下一句时记进等待，等子任务时只结算执行时间
    //（等子对话的时间归到「子对话占用」，不能既算执行又算等待）。keepAlive 会让这次调用一直不返回
    if (!st.prewarmMode) pauseRun(task, Date.now(), { idle: !helpers })
    // CLI 回复完停在等下一句：这一轮已经结束，页面不再显示执行中
    task.working = false
    // 真正处理过用户消息的轮次才算完成；预热还没处理消息时不算
    if (!st.prewarmMode && chat && !op && !helpers) {
      endTurn()
    }
    ctx.changed(true)
    try {
      return await new Promise<string | null>((resolve) => {
        let settled = false
        const done = (value: string | null) => {
          if (settled) return
          settled = true
          taskLog(task.id, helpers ? '等子任务结束' : '等下一句结束', {
            got: value === null ? 'none' : 'message',
            aborted: signal.aborted || undefined,
          })
          signal.removeEventListener('abort', onAbort)
          if (helpers) removeWaiter(task.id, w)
          else userWait.drop(w)
          if (helpers) st.waitingHelpers = false
          task.awaitingUser = false
          task.prewarming = false
          if (value === null && chat && !helpers) task.working = false
          if (!st.finished) ctx.changed(true)
          resolve(value)
        }
        const onAbort = () => done(null)
        const w: Waiter = {
          deliver: (msg, placed, recorded) => {
            taskLog(task.id, '消息交给等下一句的 CLI', { messageId: msg.id, recorded: recorded || undefined })
            // 只有用户自己的话才按「用户这次的消息」补状态；面板推的（后台命令结果、父对话传话）原样交
            st.fromUser = msg.role === 'user' && !msg.panel && !msg.peer
            // 用户发来第一句：预热结束，之后模型的输出正常记进对话
            st.prewarmMode = false
            if (!recorded) task.messages.push(msg)
            // 预热轮里撞上「强度被拒」时没法说（用户还没发话）：第一句到了再补
            tellNoEffort()
            // 继续执行：等待到此结束，从这一刻重新算执行时间
            resumeRun(task)
            // 收到用户消息，CLI 开始处理这一轮
            task.working = true
            // 之后的输出另起一条，排在用户消息后面
            st.cur = undefined
            const text = withAttachments(sourceHeader(msg) + msg.text, placed ?? msg.attachments ?? [])
            // 新的一轮从这里算起：空回合判定只看这条消息之后的输出
            st.turnMark = { from: mine.length, touched: touched.size, input: text }
            st.turnEnded = false
            // 等子任务时插进来的消息：子任务还在改文件，接着算；等下一句时来的是新要求，重新拍起点
            openChanges(helpers)
            arm(text)
            done(text)
          },
          cancel: () => done(null),
          // 等子任务时没有换 CLI 的问题：消息照样交给这个进程
          current: helpers ? () => true : stillCurrent,
        }
        // 上一次的还挂着（CLI 自己又跑了一轮再停回来）：旧的摘出等待表不再接消息，Promise 留到停止时随 signal 结束
        // 等子任务的等待照常挂；等下一句的换下还挂着的旧等待（CLI 自己又跑了一轮再停回来）
        const put = helpers ? { replaced: false, size: addWaiter(task.id, w) } : userWait.put(w)
        if (put.replaced) taskLog(task.id, '换下仍挂着的等下一句')
        taskLog(task.id, helpers ? '停下等子任务' : '停下等下一句', {
          cli: def.name,
          prewarm: st.prewarmMode || undefined,
          waiters: put.size,
          viewer: isWatched(task.id),
        })
        signal.addEventListener('abort', onAbort, { once: true })
        // 页面已经离开（宽限过了）：不再一直挂着，让 CLI 结束这一轮（排着的消息由整次执行结束后接着处理）
        if (!isWatched(task.id)) done(null)
        // 这一轮结束前后到的、排着等下一轮的消息：停稳了马上交给它
        else if (!st.prewarmMode) flushHeld(task)
      })
    } finally {
      if (task.awaitingUser || task.prewarming) {
        task.awaitingUser = false
        task.prewarming = false
        if (!st.finished) ctx.changed(true)
      }
    }
  }
  /**
   * 交给 CLI 的用户下一条消息（保活、模型自己调 wait_user_message 两条路一样）：以前原样交给 CLI，
   * 计划进度、子对话发来的消息、改动清单、授权变化都带不进去，也没有「## 用户这次的消息」标题。
   * 交给调用方按当前状态补上变了的段落（见 shared/prompt-delta.ts）；子任务结果、/命令照旧原样
   */
  const withState = async (text: string | null) => {
    // /bug 面板自己展开，原样交过去 Claude Code 会当成它自己的同名命令
    const bug = text !== null && st.fromUser ? bugSlash(text, task, !!call.orch?.coordinator) : undefined
    if (bug) return bug
    if (text === null || !st.fromUser || !call.nextPrompt || text.trim().startsWith('/')) return text
    return call.nextPrompt(text).catch((e) => {
      // 拼不出带状态的提示时退回原文照常交给 CLI（用户的话不能丢），但要留日志，不悄悄吞掉
      log.warn('task', '下一条消息没能补上当前状态，按原文交给 CLI', { task: task.id, error: (e as Error).message })
      return text
    })
  }
  // 模型主动调 wait_user_message 等下一句：这个工具是面板用 MCP 注进去的，只有能挂 MCP 的 CLI 才有。
  // 预热也走这里（预热提示让模型直接调它）：等到的用户消息同样按当前状态补段落
  const waitUser = canTake
    ? async () => {
        st.fromUser = false
        return withState(await waitNext(true))
      }
    : undefined
  // 面板保活：回复完这一轮不关进程，用户的下一条消息交给同一个进程开下一轮（不靠模型主动调等待工具）。
  // 只在对话页确实开着时这样做：没人看的时候留着一个 CLI 也没人会回来发消息
  const keepAlive = canWait
    ? async () => {
        if (!hasViewer(task.id)) return null
        // 这一轮什么都没收到：不保活，直接让它返回，交给收尾处报错
        if (emptyTurn()) return null
        // 连接断了（含 Claude Code 的输出中断判定，触发后它不自己重试）：不保活，交给收尾处报错并续接会话
        if (st.result && !st.result.ok && isNetError(st.result.error ?? '')) return null
        st.fromUser = false
        const text = await waitNext(false)
        // 拿到下一句就是新一轮开始了：上一轮模型有没有等过，跟新一轮无关
        if (text !== null) st.toolWaited = false
        return withState(text)
      }
    : undefined
  return { waitUser, keepAlive }
}
