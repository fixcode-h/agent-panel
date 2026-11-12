// runAgent 一轮失败后的自救（重构文档第 3 条：按阶段拆 runAgent）。
//
// 按报错决定怎么重跑：去掉思考强度、丢会话重开（会话找不到 / 在别的目录 / 接口拒绝历史）、
// 环境性卡住放宽等待再试、断流续接、压缩抖动续一轮、上下文超长裁剪后换新会话；都不成就报失败。
// 每次重跑前都在对话里留一行（AGENTS.md「Agent 执行出的错误一律显示给用户」），
// 重跑带的续接记录放在 RetryState 里，用 `...rs` 展开传下去，环境性重试的计数和留痕就不会漏传。
import type { Task, TaskMessage } from '../../shared/schema.ts'
import type { CliDefinition } from '../../shared/clis.ts'
import type { AgentCall, AgentResult } from '../../shared/engine/host.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { clip } from '../../shared/text.ts'
import { t } from '../../shared/i18n.ts'
import { markNoEffort } from '../models.ts'
import { log } from '../log.ts'
import type { RealContext } from './real-context.ts'
import { exitReason, stderrTail, type ProcessResult } from './process.ts'
import type { CliEvent } from './parsers.ts'
import { clippedTranscript, contextFallbackKind, restartCarry } from './transcript.ts'
import {
  SESSION_NOT_FOUND,
  firstNoEffortTell,
  noEffortRetryText,
  restartNoteText,
  settleNetNotes,
  type ContextNote,
  type NetNote,
} from './recovery.ts'
import { CompactTracker, overflowCompact, shouldRetryThrash, thrashNote, THRASH_RETRY_PROMPT } from './compaction.ts'
import type { ContextUsage } from './usage-record.ts'
import {
  EFFORT_REJECTED,
  type EnvStallNote,
  MAX_NET_RETRIES,
  SESSION_OTHER_PROJECT,
  envStallBudget,
  envStallFailure,
  envStallNote,
  envStallTimeout,
  failureHints,
  isNetError,
  shouldRetryEnvStall,
} from './retry-policy.ts'

/** 一串自动重跑之间要接着传的记录：第一次调用用 freshRetry() */
export interface RetryState {
  /** 已经换过做法重跑过（去强度、丢会话、裁剪重开）：同类的不再重跑第二次 */
  retried: boolean
  /** 断流续接过几次 */
  netRetries: number
  /** 丢会话重开时带给新会话的之前的对话 */
  retryCarry: string
  /** 这一串自动续接里已经写进对话的报错：续接成功后要收回成普通说明 */
  netNotes: NetNote[]
  /** 上下文超长降级时写进对话的提示：新会话接上了要收回成普通说明 */
  contextNotes: ContextNote[]
  /** 这一轮因为环境性失败（进程活着却没有输出）自动重试过几次：只重试一次，不能循环 */
  envStalls: number
  /** 环境性失败重试时写进对话的提示：重试成功要收回成普通说明 */
  envStallNotes: EnvStallNote[]
}

export const freshRetry = (): RetryState => ({
  retried: false,
  netRetries: 0,
  retryCarry: '',
  netNotes: [],
  contextNotes: [],
  envStalls: 0,
  envStallNotes: [],
})

/** 换参数重跑、自动压缩这类又一次完整调用：续接记录从头算，环境性重试的计数和留痕接着传 */
export const keepEnvStall = (rs: RetryState): RetryState => ({
  ...freshRetry(),
  envStalls: rs.envStalls,
  envStallNotes: rs.envStallNotes,
})

/** 失败自救要用到的：这次调用的身份、进程结果和 runAgent 里的几个帮手 */
export interface RecoverDeps {
  ctx: RealContext
  call: AgentCall
  task: Task
  def: CliDefinition
  cliId: string
  model: string
  effort: string | undefined
  sessionKey: string
  step: string
  agentId: string
  cwd: string
  chat: boolean
  op: AgentCall['op']
  prewarm: boolean
  /** 这次续接了已有会话 */
  resume: boolean
  /** 预热中（用户还没发话） */
  prewarmMode: boolean
  /** CLI 的结果事件：报了失败原因的在这里 */
  result: Extract<CliEvent, { type: 'result' }> | undefined
  /** 进程的结局 */
  r: ProcessResult
  errors: string[]
  rs: RetryState
  noEffortKey: string
  compaction: CompactTracker
  /** 这次调用的上下文占用记录（见 usage-record.ts 的 contextUsage） */
  cu: () => ContextUsage
  recoveryNote: (text: string, evenPrewarm?: boolean) => void
  carryForRestart: () => string
  carryUpto: () => number
  carryBudget: () => number
  /** 按新的提示和续接记录再跑一次 runAgent */
  rerun: (call: AgentCall, rs: RetryState) => Promise<AgentResult>
}

/** 这一轮失败了：能自救就重跑（返回重跑的结果），不能就返回带完整原因的失败 */
export async function recoverFailure(d: RecoverDeps): Promise<AgentResult> {
  const { ctx, call, task, def, cliId, model, effort, sessionKey, step, agentId, cwd, chat, op, prewarm } = d
  const { resume, result, r, errors, rs, noEffortKey, compaction, cu, recoveryNote, rerun } = d
  const { carryForRestart, carryUpto, carryBudget } = d
  const { retried, netRetries, netNotes, contextNotes, envStalls, envStallNotes } = rs
  const detail = [result?.error, ...errors, stderrTail(r.stderr, 6, def.stderrNoise)].filter(Boolean).join('\n')
  // 自定义接口的模型不支持调整思考强度：记住，去掉强度再跑一次（CLI 启动时就退出，没有实际输出）
  if (effort && !retried && EFFORT_REJECTED.test(detail)) {
    markNoEffort(cliId, model)
    log.warn('agent', `${def.name} 的模型 ${model} 不支持设置思考强度，去掉后重试`, {
      task: task.id,
      step,
      detail: detail.slice(0, 500),
    })
    recoveryNote(noEffortRetryText(model, effort, detail))
    // 说过了，重跑那次不再补「这一轮没有传」；预热轮没说，留给第一句到了再补
    if (!d.prewarmMode) firstNoEffortTell(noEffortKey)
    // 换参数重跑：续接记录保持默认（这次没有），环境性重试的计数和留痕要接着传
    return rerun(call, { ...keepEnvStall(rs), retried: true })
  }
  // 丢会话重开前留一行（原因、带没带上之前的对话、原始报错）。之前断流续接写的红卡也在这里收口：
  // 会话都没了，后面是新会话重新执行，不能等成功后写成「从中断的地方继续了」
  const restartNote = (why: string, carried: boolean) => {
    settleNetNotes(netNotes, true)
    recoveryNote(restartNoteText(why, { chat, carried, detail }))
  }
  // 会话找不到时（例如 CLI 清理了历史），丢掉会话重新开始一次
  if (resume && !prewarm && !retried && SESSION_NOT_FOUND.test(detail)) {
    delete task.sessions[sessionKey]
    delete task.sessionDirs[sessionKey]
    const carry = carryForRestart()
    log.warn('agent', `${def.name} 的会话找不到了，丢掉后重开`, { task: task.id, step, detail: detail.slice(0, 500) })
    restartNote(t('{cli} 找不到原来的会话（可能被 CLI 清理了）', { cli: def.name }), !!carry)
    // 新会话没有之前的上下文：节点用完整提示，对话把之前的对话裁剪后带上，不然模型突然全忘了。
    // 断流续接写的红卡已经在 restartNote 里收口，不再往下传（netRetries 照传：续接次数前后合计）
    return rerun(
      { ...call, prompt: call.fresh ?? call.prompt },
      { ...rs, retried: true, retryCarry: carry, netNotes: [] },
    )
  }
  // 会话存在别的项目目录里，CLI 要交互确认分叉才继续（Pi 的「Session found in different project」）：
  // 非交互模式拿不到回答，CLI 直接按 Aborted 退出。旧任务没记会话目录时只能碰运气，撞上了就丢掉会话重开一次
  if (resume && !prewarm && !retried && SESSION_OTHER_PROJECT.test(detail)) {
    delete task.sessions[sessionKey]
    delete task.sessionDirs[sessionKey]
    log.warn('agent', `${def.name} 的会话在别的目录里，丢掉后重开`, {
      task: task.id,
      step,
      cwd,
      detail: detail.slice(0, 500),
    })
    const carry = carryForRestart()
    restartNote(t('{cli} 的会话存在别的项目目录里，面板没法回答它「要不要分叉到当前目录」', { cli: def.name }), !!carry)
    return rerun(
      { ...call, prompt: call.fresh ?? call.prompt },
      { ...rs, retried: true, retryCarry: carry, netNotes: [] },
    )
  }
  // 接口拒绝了这条会话的历史（换过模型、网关换了上游，或历史里的内容片段丢了）：
  // 之后每次请求都会失败，丢掉会话重开一次；对话把之前的记录带上，节点用完整提示
  if (
    resume &&
    !prewarm &&
    !op &&
    !retried &&
    (/input\.content/i.test(detail) || /text part\b[^\n]*\bnot found/i.test(detail))
  ) {
    delete task.sessions[sessionKey]
    delete task.sessionDirs[sessionKey]
    // 按预算裁剪：原来带的是不设上限的整段，重开那次已经算重试过，历史超窗口时不会再降级，直接失败
    const carry = carryForRestart()
    log.warn('agent', `${def.name} 的会话和当前模型不兼容，丢掉旧会话重开`, {
      task: task.id,
      step,
      detail: detail.slice(0, 500),
    })
    restartNote(t('模型接口拒绝了 {cli} 这个会话的历史（常见于中途换了模型或网关）', { cli: def.name }), !!carry)
    return rerun(chat ? call : { ...call, prompt: call.fresh ?? call.prompt }, {
      ...rs,
      retried: true,
      retryCarry: carry,
      netNotes: [],
    })
  }
  const hints = failureHints(detail, def)
  // 先写进程怎么结束的（退出码、被外部杀掉时的信号）：被 kill -9 时退出码是 null，只看 stderr 会误判原因
  const how = exitReason(r)
  const head = how
    ? t('{cli} 执行失败（{reason}）：', { cli: def.name, reason: how })
    : t('{cli} 执行失败：', { cli: def.name })
  const raw = clip(detail || t('没有更多信息'), 1500)
  const message = [head, ...hints, hints.length ? `\n${t('原始输出：')}\n${raw}` : raw].join('\n')
  // 环境性卡住（请求超时，但进程还活着、一个字都没输出）：面板这边没等够，不是用户的要求有问题。
  // 先把这件事写进对话，放宽这一轮的等待再跑一次（只一次，不能循环）；
  // 这时旧进程已经结束（invokeCli 返回前它就退出了），不会留着孤儿进程
  const budget = envStallBudget(cliId)
  if (
    shouldRetryEnvStall({
      stall: !!result?.envStall,
      retries: envStalls,
      aborted: ctx.signal.aborted,
      prewarm,
      budget,
    })
  ) {
    const timeoutMs = envStallTimeout(cliId)
    const note: TaskMessage = {
      id: ctx.newId(),
      role: 'system',
      agentId,
      step,
      text: [message, '', envStallNote(timeoutMs)].join('\n'),
      tools: [],
      error: true,
      alert: makeAlert('warn', raw, 'no_response'),
      at: new Date().toISOString(),
    }
    task.messages.push(note)
    log.warn('agent', `${def.name} 没有响应（进程还活着、没有输出），放宽等待自动重试一次`, {
      task: task.id,
      step,
      timeoutMs,
    })
    ctx.changed(true)
    return rerun(call, {
      ...rs,
      envStalls: envStalls + 1,
      envStallNotes: [...envStallNotes, { msg: note, base: message }],
    })
  }
  // 连接中途断开（多半是输出很长时被服务端或代理断开）：有会话就续接让它接着做，最多两次。
  // 每次断开都把完整报错写进节点里再续接，不能悄悄重试，否则页面上只看到 Agent 反复说同一句话
  const session = task.sessions[sessionKey]
  if (isNetError(detail) && session && !prewarm && netRetries < MAX_NET_RETRIES && !ctx.signal.aborted) {
    const note: TaskMessage = {
      id: ctx.newId(),
      role: 'system',
      agentId,
      step,
      text: [
        message,
        '',
        t('正在自动续接会话重试（第 {n}/{max} 次）…', { n: netRetries + 1, max: MAX_NET_RETRIES }),
      ].join('\n'),
      tools: [],
      error: true,
      alert: makeAlert('warn', raw, 'network'),
      at: new Date().toISOString(),
    }
    task.messages.push(note)
    const nextNotes = [...netNotes, { msg: note, base: message, n: netRetries + 1 }]
    log.warn('agent', `${def.name} 连接中断，自动续接第 ${netRetries + 1} 次`, { task: task.id, step, detail })
    ctx.changed(true)
    return rerun(
      {
        ...call,
        // 原来的提示存进 fresh：续接时原会话没了（会话找不到等）会改用 fresh 开新会话，
        // 不存的话发进空会话的是这句「从中断的地方继续」，新会话根本不知道要做什么
        fresh: call.fresh ?? call.prompt,
        prompt:
          '刚才和模型服务的连接中断了，请从中断的地方继续完成之前的任务，已经做完的不用重做。' +
          '如果是在一次写入很长的文件时断开的，请分几次写：先写前一部分，再分段追加，每次不要太长。',
      },
      { ...rs, netRetries: netRetries + 1, retryCarry: '', netNotes: nextNotes },
    )
  }
  // 自动压缩抖动：CLI 压缩完马上又被一次工具输出填满、放弃了这一轮。多半是一次读进来太多，
  // 在原会话里续一轮、让模型分段读取常常就过去了；只续一次，续之前在对话里写一行警告（不悄悄重试）
  if (
    shouldRetryThrash({
      detail,
      pattern: def.compactThrash,
      session: !!session,
      prewarm,
      compact: op?.kind === 'compact',
      aborted: ctx.signal.aborted,
      tried: contextNotes.some((n) => n.thrash),
    })
  ) {
    const note = thrashNote({ id: ctx.newId(), agentId, step, message, raw })
    task.messages.push(note)
    log.warn('agent', `${def.name} 自动压缩抖动，在原会话里续一轮`, {
      task: task.id,
      step,
      detail: detail.slice(0, 500),
    })
    ctx.changed(true)
    return rerun(
      // 原来的提示存进 fresh：续接时原会话没了会改用它开新会话（和断流续接一样）
      { ...call, fresh: call.fresh ?? call.prompt, prompt: THRASH_RETRY_PROMPT },
      { ...rs, retryCarry: '', contextNotes: [...contextNotes, { msg: note, base: message, thrash: true }] },
    )
  }
  // 上下文已经超过模型上限：同一段历史再发一次只会一样被拒，压缩也一样（它要把历史整段重发）。
  // 唯一能做的自救是丢掉会话、把对话裁剪到预算内换成新会话接着做；只降一次（retried）
  const fallback = contextFallbackKind({
    detail,
    retried,
    prewarm,
    aborted: ctx.signal.aborted,
    compact: op?.kind === 'compact',
    chatResume: Boolean(chat && resume),
  })
  if (fallback) {
    // 压缩：不再请求模型（它照样会拒），把裁剪后的记录当作摘要写进 rewind，按压缩成功返回，下一轮开新会话带上
    if (fallback === 'compact') {
      const summary = overflowCompact({
        task,
        sessionKey,
        clipped: clippedTranscript(task, task.messages.length, carryBudget()),
        usage: cu(),
        tracker: compaction,
        msg: (text) => ({
          id: ctx.newId(),
          role: 'system',
          agentId,
          step,
          text,
          tools: [],
          at: new Date().toISOString(),
        }),
      })
      ctx.changed(true)
      log.warn('agent', `${def.name} 压缩上下文时仍然超过上限，改用裁剪后的记录开新会话`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      return { ok: true, text: summary }
    }
    // 普通一轮：丢掉会话，把对话裁剪后交给新会话（复用 retryCarry 的续接路径）
    if (fallback === 'restart') {
      delete task.sessions[sessionKey]
      delete task.sessionDirs[sessionKey]
      // 和丢会话重开同一份裁剪（审查操作也走这里，所以不用 carryForRestart 的「操作不带」）
      const carry = restartCarry(task, carryUpto(), carryBudget())
      const note: TaskMessage = {
        id: ctx.newId(),
        role: 'system',
        agentId,
        step,
        text: [
          message,
          '',
          t('这次请求的上下文已经超过 {cli} 的上限。正在丢掉旧会话，把对话裁剪后开新会话接着做…', { cli: def.name }),
        ].join('\n'),
        tools: [],
        error: true,
        alert: makeAlert('warn', raw, 'context'),
        at: new Date().toISOString(),
      }
      task.messages.push(note)
      log.warn('agent', `${def.name} 的上下文超过上限，丢掉旧会话并裁剪后重开`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      ctx.changed(true)
      return rerun(call, {
        ...rs,
        retried: true,
        retryCarry: carry,
        contextNotes: [...contextNotes, { msg: note, base: message }],
      })
    }
  }
  log.error('agent', `${def.name} 执行失败`, { task: task.id, step, code: r.code, detail })
  // 两次都没等到响应：失败卡片里写明面板已经重试过一次，不让用户以为是第一次就失败
  const tried = [
    netRetries ? t('已自动续接 {n} 次，仍然失败。', { n: netRetries }) : '',
    envStalls ? envStallFailure(envStalls) : '',
    contextNotes.some((n) => n.thrash) ? t('已在原会话里续过一轮，仍然失败。') : '',
  ].filter(Boolean)
  return { ok: false, error: tried.length ? [message, '', ...tried].join('\n') : message }
}
