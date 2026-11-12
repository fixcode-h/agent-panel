// runAgent 收 CLI 流事件的那一段（重构文档第 3 条：按阶段拆 runAgent）。
//
// 每个事件改哪些共享状态：当前回复 st.cur、思考 st.thinkingOf、用量 st.usageSeen / st.reported、
// 结果 st.result、插话的断开时机 st.cutAfter / st.steerPending、预热 st.prewarmMode、重试前安静多久 st.quietBefore。
// 其余（任务上的消息、用量、会话、待办、请求）直接写在 task 上，由 ctx.changed 落盘推送。
import type { AgentUsage, Task, TaskMessage, ToolUse } from '../../shared/schema.ts'
import type { CliDefinition } from '../../shared/clis.ts'
import type { AgentCall } from '../../shared/engine.ts'
import { addFirstToken } from '../../shared/first-token-stats.ts'
import { stripLongContext } from '../../shared/model-limits.ts'
import { modelLimitsFor } from '../../shared/model-catalog.ts'
import { priceCost } from '../../shared/model-price.ts'
import { compactedSilently } from '../../shared/prompt-delta.ts'
import { stepUsage } from '../../shared/task.ts'
import { t } from '../../shared/i18n.ts'
import { setLimits } from '../cli-extras.ts'
import { log } from '../log.ts'
import { taskLog } from '../task-log.ts'
import type { CliEvent } from './parsers.ts'
import type { RealContext } from './real-context.ts'
import type { RunState } from './run-state.ts'
import { settleRetryNotes } from './recovery.ts'
import type { CompactTracker } from './compaction.ts'
import { noticeRow } from './notice-row.ts'
import { NOT_RESPONSE, PREWARM_QUIET, continuesOutput } from './event-kinds.ts'
import { askViaParent } from './child-question.ts'
import { replies } from './panel-requests.ts'
import { autoAllowed, requestOf } from './ask-request.ts'
import type { createStallWatch } from './stall-watch.ts'
import type { createDrafting } from './drafting.ts'
import type { createToolRows } from './tool-rows.ts'
import type { createFileEvents } from './file-events.ts'
import type { speedMeter } from './speed-meter.ts'
import type { resolveModelRun } from './model-run.ts'

/** 收事件要用到的：这次调用的身份、共享状态，以及 runAgent 里建好的几个记录器 */
export interface EventDeps {
  ctx: RealContext
  task: Task
  st: RunState
  def: CliDefinition
  cliId: string
  model: string
  entries: Awaited<ReturnType<typeof resolveModelRun>>['entries']
  sessionKey: string
  cwd: string
  owner: Task['steps'][number] | undefined
  step: string
  agentId: string
  chat: boolean
  op: AgentCall['op']
  /** 这一轮开始时对话里有几条消息：重试卡片只收这之后的 */
  turnStart: number
  /** 这次启动选的权限档（审批自动放行看它） */
  permission: string | undefined
  watch: ReturnType<typeof createStallWatch>
  drafting: ReturnType<typeof createDrafting>
  meter: ReturnType<typeof speedMeter>
  compaction: CompactTracker
  toolRows: ReturnType<typeof createToolRows>
  fileEvents: ReturnType<typeof createFileEvents>
  toolStart: Map<ToolUse, number>
  turn: { id: string; end: string }
  errors: string[]
  asked: string[]
  newMsg: () => TaskMessage
  streamed: (text: string) => void
  au: () => AgentUsage
  windowFor: (model: string) => number
  compacted: () => void
  refreshChanges: () => void
  checkRedirect: () => void
  endTool: (x: ToolUse) => void
  emptyTurn: () => boolean
  endTurn: () => void
  turnTools: () => number
}

/** 收一个 CLI 事件：写进对话、用量、会话记录，必要时断开当前回复另起一条 */
export function createApply(d: EventDeps): (ev: CliEvent) => void {
  const { ctx, task, st, def, cliId, model, entries, sessionKey, cwd, owner, step, agentId, chat, op, turnStart } = d
  const { watch, drafting, meter, compaction, toolRows, fileEvents, toolStart, turn, errors, asked } = d
  const { newMsg, streamed, au, windowFor, compacted, refreshChanges, checkRedirect } = d
  const { endTool, emptyTurn, endTurn, turnTools } = d
  const { arm, heard } = watch
  return (ev: CliEvent) => {
    // 有了真正的输出：不算卡住。工具结果交回去、开始一次模型请求后，重新开始等模型的回应
    if (ev.type === 'notice') st.quietBefore = watch.quietMs()
    if (!NOT_RESPONSE.has(ev.type)) heard()
    drafting.see(ev)
    if (ev.type === 'tool_result' || ev.type === 'request_start') arm()
    // 预热时模型可能先回一句话再调用等待工具：这些不显示，也不占消息
    if (st.prewarmMode && PREWARM_QUIET.has(ev.type)) return
    // 插话收下时正在输出的那段话：说完再断开，用户的消息排在它后面，不把一句话从中间劈开
    if (st.cutAfter && !continuesOutput(ev, st.cur)) {
      st.cutAfter = false
      st.cur = undefined
    }
    // 延迟取走的补充：CLI 开始下一次模型请求时说明它真的接受了补充，之后的输出另起一条。
    // 消息本身在交出去时就已经记进对话，这里只断开输出
    if (st.steerPending && ev.type === 'request_start') {
      st.steerPending = false
      clearTimeout(st.redirectTimer)
      st.redirectTimer = undefined
      st.cur = undefined
      st.prewarmMode = false
      task.prewarming = false
      task.working = true
      ctx.changed(true)
    }
    if (st.thinkingOf && ev.type !== 'thinking' && ev.type !== 'usage' && ev.type !== 'limits' && ev.type !== 'session')
      st.thinkingOf = undefined
    switch (ev.type) {
      case 'session':
        // 会话换了（找不到、换了 CLI / 目录后开的新会话）：记下前后，「状态」诊断里看得出这是第几个会话、为什么换（ADR 0042）
        if (task.sessions[sessionKey] && task.sessions[sessionKey] !== ev.id)
          taskLog(task.id, '换了新会话', { key: sessionKey, from: task.sessions[sessionKey], to: ev.id })
        task.sessions[sessionKey] = ev.id
        // 会话按目录存：每个会话都记下是在哪开的，续接前先看（子任务也一样）
        task.sessionDirs[sessionKey] = cwd
        if (chat) {
          task.sessionCli = cliId
          task.sessionDir = cwd
        }
        break
      case 'thinking': {
        // 思考属于接下来的那段回复：当前消息已经有文字或工具时另起一条
        const m = !st.cur || st.cur.text.trim() || st.cur.tools.length ? newMsg() : st.cur
        m.thinking = ev.delta ? (m.thinking ?? '') + ev.text : ev.text
        // CLI 报了这段用了多久就用它；否则从第一段到达算到最新一段，边想边更新
        if (ev.ms !== undefined) m.thinkingMs = (m.thinkingMs ?? 0) + ev.ms
        else {
          if (st.thinkingOf?.m !== m) st.thinkingOf = { m, at: Date.now() - (m.thinkingMs ?? 0) }
          m.thinkingMs = Date.now() - st.thinkingOf.at
        }
        streamed(ev.text)
        break
      }
      case 'gen':
        streamed(ev.text)
        break
      case 'text_delta': {
        if (!st.cur && !ev.text.trim()) break
        const m = st.cur ?? newMsg()
        m.text += ev.text
        streamed(ev.text)
        break
      }
      case 'text': {
        const m = st.cur ?? newMsg()
        m.text = m.text ? `${m.text.trimEnd()}\n\n${ev.text}` : ev.text
        break
      }
      case 'tool': {
        // 等下一句是面板内部的保活机制，不占一行工具调用
        if (ev.tool.label.includes('wait_user_message')) break
        const m = !st.cur || st.cur.text.trim() ? newMsg() : st.cur
        m.text = ''
        m.tools.push(ev.tool)
        if (ev.id) toolRows.added(ev.id, ev.tool)
        // 调用时就带着耗时的（完成后才报的）直接用；要等结果的从现在开始计时
        if (ev.tool.ms === undefined && (ev.id || ev.tool.running)) {
          ev.tool.startedAt = Date.now()
          toolStart.set(ev.tool, ev.tool.startedAt)
          // 补充还排着时又开始跑命令：同样要等它跑完才取，一起计时
          if (st.steerPending && !st.redirectTimer) checkRedirect()
        }
        fileEvents.track(ev.tool, ev.file, toolStart.has(ev.tool))
        break
      }
      case 'usage': {
        st.usageSeen = true
        const u = au()
        // 报回来的模型名去掉长上下文后缀（[1m]），显示和按模型查映射、目录都用原名
        if (ev.model) u.model = stripLongContext(def, ev.model)
        if (ev.context !== undefined) {
          // 对话的会话里上下文骤降：CLI 自己压缩了却没报 compacted，同样作废已发的规则段落
          if (chat && compactedSilently(u.context, ev.context)) compacted()
          u.context = ev.context
        }
        if (ev.window) {
          u.window = ev.window
          st.reported = true
        } else if (!st.reported) u.window = windowFor(u.model || model)
        if (ev.context !== undefined) compaction.measured(ev.context, u.window)
        u.outputTokens = (u.outputTokens ?? 0) + (ev.addOutput ?? 0)
        meter.real(ev.addOutput ?? 0)
        // 任务的累计和节点自己的都记一份，右栏点了节点时只看节点的
        for (const t of owner ? [task.usage, stepUsage(owner)] : [task.usage]) {
          t.inputTokens += ev.addInput ?? 0
          t.outputTokens += ev.addOutput ?? 0
          t.cacheReadTokens = (t.cacheReadTokens ?? 0) + (ev.addCacheRead ?? 0)
          t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + (ev.addCacheWrite ?? 0)
          // CLI 不报费用（Codex、Command Code）时按模型目录里填的单价折算（shared/model-price.ts）
          t.costUsd += ev.addCost ?? priceCost(modelLimitsFor(u.model || model, { entries }).entry?.price, ev)
        }
        if (owner?.usage) Object.assign(owner.usage, { context: u.context, window: u.window, model: u.model })
        break
      }
      case 'context': {
        // CLI 自己报的上下文细分：会话栏优先按它分块（一轮结束后才到，单独推一次）
        au().snapshot = ev.snapshot
        // 刚压缩完还不知道整个上下文多大：细分里的总占用就是压缩后的真实大小
        const fixed = compaction.measured(ev.snapshot.used, ev.snapshot.window || au().window)
        if (fixed) au().context = ev.snapshot.used
        ctx.changed(fixed)
        break
      }
      case 'tool_result':
        toolRows.result(ev)
        break
      case 'tool_delta':
        toolRows.delta(ev)
        break
      case 'files_changed':
        refreshChanges()
        return
      case 'turn':
        if (ev.id) turn.id = ev.id
        if (ev.end) turn.end = ev.end
        return
      case 'limits':
        setLimits(cliId, ev.limits)
        return
      case 'compacting': {
        // CLI 自己开始压缩（自动压缩）：像后台命令一样先放一行转圈，压缩完成（compacted）再收掉
        const tool = compaction.startCli(au().context || undefined, toolStart)
        if (tool) (!st.cur || st.cur.text.trim() ? newMsg() : st.cur).tools.push(tool)
        break
      }
      case 'compacted': {
        // 压缩后会话里之前发过的规则只剩摘要：下一轮按完整提示重发（见 shared/prompt-delta.ts）
        compacted()
        // 当作一次工具调用放进回复里，不插一条系统消息把回复切成两段；压缩后的大小晚一点从 usage 补上
        const tool = compaction.done(ev, au())
        if (tool) (!st.cur || st.cur.text.trim() ? newMsg() : st.cur).tools.push(tool)
        ctx.changed(true)
        break
      }
      case 'todos':
        // 只替换这个 Agent 自己的清单，工作流里其他 Agent 的不动
        task.todos = [
          ...(task.todos ?? []).filter((x) => x.agentId !== agentId),
          ...ev.todos.map((x) => ({ ...x, agentId })),
        ]
        break
      case 'model':
        // 模型请求的耗时记在这段回复上：两步之间看起来「卡住」的时间大多在这里
        if (st.cur) st.cur.modelMs = (st.cur.modelMs ?? 0) + ev.ms
        break
      case 'wait': // 首包时间（cli-trace 算好的），会话栏显示：分得清是链路慢还是模型一直在想
        au().firstToken = addFirstToken(au().firstToken, ev.ms)
        break
      case 'error':
        errors.push(ev.message)
        break
      case 'notice': {
        // 重试、失败、面板工具没接上：写进日志，放进回复里当一行状态，不打断回复（见 notice-row.ts）
        // 重试用完了：前面那张「正在重试」收掉，失败原因看这一行
        if (ev.kind === 'retry_failed') settleRetryNotes(task.messages, t('重试用完了，没有恢复'), turnStart)
        const m = !st.cur || st.cur.text.trim() ? newMsg() : st.cur
        m.tools.push(noticeRow(ev, { task: task.id, step, cli: def.name }, st.quietBefore))
        break
      }
      case 'retry_ok': {
        // 重试成功不是提示：把前面那张「正在重试」收成已恢复，不再多插一行（没有卡片时什么都不加）
        log.info('agent', ev.text, { task: task.id, step, cli: def.name, kind: 'retry_ok', attempt: ev.attempt })
        settleRetryNotes(task.messages, ev.text, turnStart)
        break
      }
      case 'result':
        st.result = ev
        // 这一轮结束了：之后没有输出是在等下一句，不算卡住
        watch.disarm()
        // 留一条「为什么停」：排查「说了要做却没调工具就结束」时看是模型自己收尾（end_turn）还是被截断
        if (chat && !op)
          log.info('agent', `${def.name} 这一轮结束`, {
            task: task.id,
            step,
            ok: ev.ok,
            stopReason: ev.stopReason ?? '',
            tools: turnTools(),
            model,
          })
        // 一轮结束还没等到结果的调用（被打断、CLI 没报结果）：算到这里为止
        for (const x of [...toolStart.keys()]) endTool(x)
        // 一轮结束以 CLI 的 result 为准：进程还活着也可能已经回复完了
        if (chat && !op) {
          task.working = false
          // 什么都没收到的不算完成：这一轮要交给收尾处报错，不能先记成已完成
          if (ev.ok && !st.prewarmMode && !emptyTurn()) {
            endTurn()
          }
        }
        break
      case 'ask': {
        // 预热时用户还没发消息：不要让页面弹出确认/提问，直接拒绝并让它去等下一句
        if (st.prewarmMode) {
          ev.reply({ allow: false, message: '预热中，用户还没有发新消息；不要做别的，直接调用 wait_user_message。' })
          return
        }
        // 子对话开着「提问」：交给父对话，不在子对话里弹给用户（见 askViaParent）
        if (ev.kind === 'question' && task.parentTaskId && ctx.messageParent) return askViaParent(ev, ctx.messageParent)
        const id = ctx.newId()
        // 审批卡上点过「一直允许」的同类请求、权限是「跳过所有确认」这类一档：直接允许，留一行说明（ask-request.ts）
        const perm = def.permissions.find((p) => p.id === d.permission)
        if (autoAllowed(task, ev, { id, step, agentId }, perm?.autoAllow ? perm.label : '')) return ctx.changed(true)
        asked.push(id)
        replies.set(id, ev.reply)
        task.requests.push(requestOf(ev, { id, step, agentId }))
        // 新的请求马上落盘，侧栏的铃铛和任务页立刻能看到
        ctx.changed(true)
        return
      }
    }
    ctx.changed()
  }
}
