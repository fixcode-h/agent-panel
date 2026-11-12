// runAgent 进程结束后的两段（重构文档第 3 条：按阶段拆 runAgent）：
// afterProcess 在 invokeCli 的 finally 里收拾这次调用登记的东西（插话通道、补充、请求、计时器），
// finishTurn 在这一轮成功结束时收口（空回合报错、续接留痕收回、用量提醒、压缩和自动压缩）。
import type { Alert, Task, TaskMessage, ToolUse } from '../../shared/schema.ts'
import type { CliDefinition } from '../../shared/clis.ts'
import type { AgentCall, AgentResult } from '../../shared/engine-host.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { dropAsked } from '../../shared/tasks/settle.ts'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'
import { taskLog } from '../tasks/log.ts'
import type { RealContext } from './real-context.ts'
import type { RunState } from './run-state.ts'
import { holdForNextTurn, removeNoteTaker, type NoteTaker } from './delivery.ts'
import { cancelWait, notes, steers } from './steering.ts'
import { replies } from './panel-requests.ts'
import { settleCompactRow, type CompactTracker } from './compaction.ts'
import { settleContextNotes, settleNetNotes } from './recovery.ts'
import { settleEnvStallNotes, silentTurn } from './retry-policy.ts'
import { keepEnvStall, type RetryState } from './run-recover.ts'
import type { ContextUsage } from './usage-record.ts'
import type { createStallWatch } from './stall-watch.ts'
import type { createDrafting } from './drafting.ts'
import type { speedMeter } from './speed-meter.ts'

/** 收拾这次调用登记的东西要用到的 */
export interface CleanupDeps {
  ctx: RealContext
  task: Task
  st: RunState
  def: CliDefinition
  step: string
  agentId: string
  chat: boolean
  drafting: ReturnType<typeof createDrafting>
  watch: ReturnType<typeof createStallWatch>
  meter: ReturnType<typeof speedMeter>
  compaction: CompactTracker
  plugins: { close: () => void } | undefined
  taker: NoteTaker | undefined
  toolStart: Map<ToolUse, number>
  pendingNotes: Set<TaskMessage>
  steered: Set<TaskMessage>
  asked: string[]
  endTool: (x: ToolUse) => void
  turnMsgs: () => TaskMessage[]
}

/** CLI 进程结束了（完成、出错、被停）：撤掉这次调用登记的通道和计时器，没交出去的补充留给下一轮 */
export function afterProcess(d: CleanupDeps) {
  const { ctx, task, st, def, step, agentId, chat, drafting, watch, meter, compaction, plugins, taker } = d
  const { toolStart, pendingNotes, steered, asked, endTool, turnMsgs } = d
  st.finished = true
  drafting.clear()
  if (chat) taskLog(task.id, '对话的 CLI 进程结束', { cli: def.name, aborted: ctx.signal.aborted || undefined })
  plugins?.close()
  watch.stop()
  clearTimeout(st.redirectTimer)
  for (const x of [...toolStart.keys()]) endTool(x)
  // CLI 说开始压缩了，进程结束都没等到压缩完成：不能显示得像压缩成功了
  compaction.processEnd()
  // CLI 一直没报告开始下一次模型请求：补充也算交给了它，输出直接另起一条
  if (st.steerPending) {
    st.steerPending = false
    st.cur = undefined
  }
  // 进程先结束了（崩溃、被停掉）：还在等下一句的那次请求也结束，别一直挂着
  cancelWait(task.id)
  // 留给「下一个节点」的补充：后面还有节点会取走时就留着，没有了就清掉。
  // 不按任务清是因为当前这个节点结束时，下一个节点还没来得及启动
  const nextStep =
    task.mode === 'workflow' &&
    task.steps.some((s) => s.id !== step && s.status !== 'done' && s.status !== 'failed' && s.status !== 'skipped')
  if (!nextStep) notes.delete(task.id)
  clearTimeout(st.gitTimer)
  if (st.steerer) {
    const set = steers.get(task.id)
    set?.delete(st.steerer)
    if (!set?.size) steers.delete(task.id)
  }
  if (taker) {
    removeNoteTaker(task.id, taker)
    // 这一轮里没取走的补充：消息已经在对话里，记下来让这一轮结束后马上接着处理
    for (const m of pendingNotes) holdForNextTurn(task.id, m)
    pendingNotes.clear()
  }
  // 插话交出去、这一轮却一个字都没产出的：CLI 收下不等于模型看见，交回下一轮重放。
  // texts 要等进程结束后才汇总，这里看 mine 里已经收到的正文
  if (!turnMsgs().some((m) => m.role === 'agent' && m.text.trim())) for (const m of steered) holdForNextTurn(task.id, m)
  steered.clear()
  meter.stop()
  for (const id of asked) replies.delete(id) // 进程结束了（完成、停止、超时）：还没回答的请求作废，并写明作废了哪些
  if (dropAsked(task, asked, { id: ctx.newId(), agentId, step })) ctx.changed(true)
  if (task.usage.agents[agentId]) task.usage.agents[agentId].tps = 0
}

/** 这一轮成功结束时收口要用到的 */
export interface FinishDeps {
  ctx: RealContext
  call: AgentCall
  task: Task
  st: RunState
  def: CliDefinition
  step: string
  agentId: string
  sessionKey: string
  chat: boolean
  op: AgentCall['op']
  prewarm: boolean
  /** 设置里的自动压缩阈值（上下文占用百分比，0 不自动压缩） */
  pct: number | undefined
  /** 这一轮是按回退 / 摘要开的新会话：成功后清掉 */
  rewind: unknown
  rs: RetryState
  texts: string[]
  errors: string[]
  touched: Set<string>
  /** 最后一轮的回复正文（空回合只看最后一轮） */
  turnTexts: string[]
  turnTools: () => number
  compaction: CompactTracker
  compacted: () => void
  /** 这次调用的上下文占用记录（见 usage-record.ts 的 contextUsage） */
  cu: () => ContextUsage
  /** 再跑一次 runAgent（自动压缩用） */
  rerun: (call: AgentCall, rs: RetryState) => Promise<AgentResult>
}

/** 进程正常结束、CLI 也没报失败：空回合按失败报，否则收口并按需自动压缩 */
export async function finishTurn(d: FinishDeps): Promise<AgentResult> {
  const { ctx, call, task, st, def, step, agentId, sessionKey, chat, op, prewarm, pct, rewind, rs } = d
  const { texts, errors, touched, turnTexts, turnTools, compaction, compacted, cu, rerun } = d
  const { netNotes, contextNotes, envStallNotes } = rs
  // 这一轮 CLI 报了结束，却什么都没收到（没有正文、没调工具、没改文件）：CLI 或网关出了问题。
  // 按「错误一律显示」写进对话，这一轮按失败结束；不自动重试，由用户决定重发、继续还是换模型。
  // 不限定对话：子 Agent（工作流节点、并行子任务）同样可能空着收尾，那一路要让失败报回派它的一方。
  if (
    !op &&
    !prewarm &&
    !ctx.signal.aborted &&
    silentTurn({ texts: turnTexts, tools: turnTools(), changed: touched.size - st.turnMark.touched })
  ) {
    const what = t('这一轮 {cli} 没有返回任何内容，这条要求没有被处理', { cli: def.name })
    task.messages.push({
      id: ctx.newId(),
      role: 'system',
      agentId,
      step,
      text: what,
      tools: [],
      error: true,
      alert: makeAlert('error', what, 'empty_turn'),
      at: new Date().toISOString(),
    })
    ctx.changed(true)
    log.error('agent', `${def.name} 没有返回任何内容`, { task: task.id, step })
    return { ok: false, error: what }
  }
  log.info('agent', `${def.name} 完成`, { task: task.id, step })
  // 续接成功了：之前那次断开的报错已经不成立，收成普通说明（否则对话里一直留着一张红色「执行失败」卡片）
  settleNetNotes(netNotes)
  // 上下文超长降级：裁剪后的新会话接上了，那张失败卡片同样要收掉
  settleContextNotes(contextNotes)
  // 环境性失败重试成功：那一轮其实做成了，同样收成普通说明
  settleEnvStallNotes(envStallNotes)
  if (netNotes.length || contextNotes.length || envStallNotes.length) ctx.changed(true)
  const done: AgentResult = { ok: true, text: texts.join('\n\n') }
  // 赋成 undefined 而不是 delete：保存时和旧记录合并，delete 掉的字段会被旧值补回来
  if (rewind) task.rewind = undefined
  const sysMsg = (text: string, error?: boolean, alert?: Alert) => {
    task.messages.push({
      id: ctx.newId(),
      role: 'system',
      agentId,
      step,
      text,
      tools: [],
      ...(error ? { error } : {}),
      ...(alert || error ? { alert: alert ?? makeAlert('error', text) } : {}),
      at: new Date().toISOString(),
    })
    ctx.changed(true)
  }
  // 这一轮调了模型、却一条用量事件都没收到（网关不回 usage）：统计会是 0，别让 0 被当成「没消耗」。
  // 正文和报错都为空时同样要说明：那一轮很可能连模型请求都没发出去，只留一行 0 的统计会看不出问题
  if (chat && !op && !prewarm && !st.usageSeen)
    sysMsg(
      texts.length || errors.length
        ? t('这次没有拿到 {cli} 报告的用量，下面的 token 和费用统计不可信（不代表没有消耗）。', { cli: def.name })
        : t('这次没有拿到 {cli} 的任何输出和用量：这条要求很可能没有被处理，可以重发或换一个模型再试。', {
            cli: def.name,
          }),
      false,
      texts.length || errors.length ? undefined : makeAlert('warn', errors.join('\n'), 'empty_turn'),
    )
  // 压缩过（原生压缩不一定报 compacted 事件）：会话里之前发过的规则段落不算数了
  if (op?.kind === 'compact') compacted()
  // 不能压缩会话的 CLI：摘要写好了，下一轮开新会话带上它
  if (op?.kind === 'compact' && def.compact === 'summary') {
    task.rewind = { session: '', through: null, latest: false, summary: done.text }
    delete task.sessions[sessionKey]
    delete task.sessionDirs[sessionKey]
    cu().context = 0
    if (!compaction.settle(t('摘要写好了，下一轮开新会话带上')))
      sysMsg(t('已压缩上下文：下一轮会开新的会话，带上这份摘要'))
  } else if (op?.kind === 'compact') compaction.finishOp(cu())
  // 达到设置的上下文占用时自动压缩（Claude Code 和 Codex 由 CLI 自己按设置压缩）
  const u = task.usage.agents[agentId]
  if (
    chat &&
    !op &&
    !prewarm &&
    pct &&
    def.autoCompact === 'panel' &&
    u?.window &&
    (u.context / u.window) * 100 >= pct
  ) {
    // 原因写在压缩那一行里（点开看），不另插一行居中的说明
    const auto = {
      kind: 'compact' as const,
      reason: t('上下文占用达到 {n}%，自动压缩', { n: Math.round((u.context / u.window) * 100) }),
    }
    // 压缩也是这一轮里的一次完整调用：环境性重试的计数和留痕要接着传，否则重置后可能再重试一次
    const c = await rerun({ ...call, op: auto }, keepEnvStall(rs))
    settleCompactRow(auto, c)
    if (!c.ok && !c.stopped) sysMsg(t('自动压缩失败：{error}', { error: c.error }), true, makeAlert('error', c.error))
  }
  return done
}
