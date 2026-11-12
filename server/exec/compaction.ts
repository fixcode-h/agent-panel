import type { AgentResult } from '../../shared/engine/host.ts'
import type { ContextSnapshot } from '../../shared/context-breakdown.ts'
import type { Task, TaskMessage, ToolUse } from '../../shared/schema.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { t } from '../../shared/i18n.ts'
import { fmtTokens, MIN_AGENT_CONTEXT } from '../../shared/model-limits.ts'

/** 压缩上下文那一行工具调用：压缩一开始就显示、转圈（像后台命令），压缩完成换成前后大小 */

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

/**
 * 压缩上下文的那一行工具调用，按压缩操作（op 对象）记：网络中断、环境性失败重试时 op 原样传下去，
 * 接着用同一行，不在对话里多出一行压缩
 */
export const compactRows = new WeakMap<object, { tool: ToolUse; t0: number; before?: number }>() // 模块状态：会话，跟着进程或连接一起没

/** CLI 报的上下文细分里固定占的部分（系统提示词、工具定义、说明文件……）：不随压缩变，消息以外的都算 */
const FIXED_SKIP = new Set(['messages', 'since', 'buffer', 'free', 'mcpDeferred', 'systemDeferred']) // 模块状态：常量，加载后不改
export function fixedContext(snap: ContextSnapshot | undefined) {
  return snap ? snap.rows.reduce((n, r) => (FIXED_SKIP.has(r.key) ? n : n + r.tokens), 0) : undefined
}

/** 正在压缩的那一行：知道压缩前多大就先写上；自动压缩的原因放在点开看的输入里 */
export function compactingTool(before?: number, reason?: string): ToolUse {
  return {
    kind: 'compact',
    name: t('压缩上下文'),
    label: before !== undefined ? t('压缩前 {before} token', { before: fmtTok(before) }) : t('正在压缩'),
    detail: '',
    ...(reason ? { input: reason } : {}),
  }
}

/**
 * 压缩这次操作（含所有重试）结束了：没成功的把那一行标成失败 / 已停止，不能停在转圈或显示得像压缩成功了。
 * 成功的在 runAgent 里已经写好了前后大小
 */
export function settleCompactRow(op: object, r: AgentResult) {
  const row = compactRows.get(op)
  if (!row) return
  compactRows.delete(op)
  if (r.ok) return
  const tool = row.tool
  delete tool.running
  delete tool.startedAt
  if (tool.ms === undefined) tool.ms = Date.now() - row.t0
  if (!r.stopped) tool.failed = true
  tool.label = r.stopped ? t('压缩已停止') : t('压缩失败')
  tool.detail = ''
  if (r.error) tool.output = r.error
}

/** 压缩上下文的工具调用：一行写压缩了多少，右边写现在占上下文窗口多少，点开看明细 */
export function describeCompaction(tool: ToolUse, before?: number, after?: number, window?: number) {
  // 前后大小单独存一份结构化字段：界面要显示「压缩前 / 压缩后」，不解析下面的中文 label
  if (before !== undefined || after !== undefined) tool.compact = { before, after }
  const pct = after !== undefined && window ? Math.round((after / window) * 100) : undefined
  // 压缩后不比压缩前小：这次压缩没起作用（实测上限设小时常见，随后 CLI 多半报压缩抖动），
  // 不能写成「压缩了 0 token」让人以为压缩正常，标成警告行
  const noEffect = before !== undefined && after !== undefined && after >= before
  tool.label =
    before !== undefined && after !== undefined
      ? noEffect
        ? t('压缩没有生效（{before} → {after}）', { before: fmtTok(before), after: fmtTok(after) })
        : t('压缩了 {freed} token（{before} → {after}）', {
            freed: fmtTok(before - after),
            before: fmtTok(before),
            after: fmtTok(after),
          })
      : before !== undefined
        ? t('压缩前 {before} token', { before: fmtTok(before) })
        : t('已压缩上下文')
  tool.detail = pct !== undefined ? t('当前占用 {pct}%', { pct }) : ''
  tool.output = [
    before !== undefined && t('压缩前：{n} token', { n: fmtTok(before) }),
    after !== undefined && t('压缩后：{n} token', { n: fmtTok(after) }),
    window && t('上下文窗口：{n} token', { n: fmtTok(window) }),
    pct !== undefined && t('当前占用：{pct}%', { pct }),
  ]
    .filter(Boolean)
    .join('\n')
  // 后来补上的真实大小可能变成生效了：警告跟着去掉
  if (noEffect)
    tool.alert = makeAlert(
      'warn',
      [t('压缩后的上下文没有比压缩前小，这次压缩没有起作用。'), tool.output].join('\n'),
      'context',
    )
  else delete tool.alert
}

/**
 * 这个角色最近一次压缩那一行还在等压缩后的大小（awaitAfter）时返回它：
 * 有的 CLI 压缩完不报用量（Codex 的手动压缩），要等下一轮第一次报用量才知道压缩后多大
 */
export function awaitingCompact(messages: TaskMessage[], agentId: string, step: string) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.agentId !== agentId || (m.step ?? '') !== step) continue
    const tool = [...m.tools].reverse().find((x) => x.kind === 'compact')
    // 只看最近的那一次压缩：更早的没等到就算了，拿后来的用量补会张冠李戴
    if (tool) return tool.compact?.awaitAfter ? tool : undefined
  }
  return undefined
}

interface Usage {
  context: number
  window: number
  snapshot?: ContextSnapshot
}

/**
 * 一次 runAgent 里的压缩：面板发起的压缩操作（按 op 记，重试接着用同一行）、CLI 自己开始的自动压缩，
 * 以及压缩完还不知道整个上下文多大、等用量或细分补上的那一行。endTool 由 runner 给（它记着开始时间）
 */
export class CompactTracker {
  row?: { tool: ToolUse; t0: number; before?: number }
  /** row 是 CLI 自己开始的自动压缩（不是面板发起的压缩操作） */
  private cli = false
  /** 刚压缩完、还不知道压缩后多大：下一次报告上下文用量或细分时补上 */
  private pending?: { tool: ToolUse; before?: number }
  constructor(
    private endTool: (x: ToolUse) => void,
    /** 上一轮压缩完还不知道多大的那一行（见 awaitingCompact）：这一轮第一次报用量时补上 */
    earlier?: ToolUse,
  ) {
    if (earlier) this.pending = { tool: earlier, before: earlier.compact?.before }
  }

  /** 面板发起的压缩开始：第一次新建一行（返回它，runner 放进新消息），重试时接着转圈 */
  startOp(op: object & { reason?: string }, before: number | undefined, toolStart: Map<ToolUse, number>) {
    let fresh: ToolUse | undefined
    // 上一次压缩还没等到压缩后的大小又压缩了：那一行不再等（之后的用量是这次压缩的）
    if (this.pending?.tool.compact?.awaitAfter) delete this.pending.tool.compact.awaitAfter
    this.pending = undefined
    this.row = compactRows.get(op)
    if (!this.row) {
      fresh = compactingTool(before, op.reason)
      this.row = { tool: fresh, t0: Date.now(), before }
      compactRows.set(op, this.row)
    }
    const tool = this.row.tool
    tool.running = true
    tool.startedAt = this.row.t0
    delete tool.ms
    delete tool.failed
    toolStart.set(tool, this.row.t0)
    return fresh
  }

  /** CLI 自己开始压缩：先放一行转圈（返回要放进回复的那一行；已经有一行在转时不重复） */
  startCli(before: number | undefined, toolStart: Map<ToolUse, number>) {
    if (this.row) return undefined
    const t0 = Date.now()
    const tool: ToolUse = { ...compactingTool(before), running: true, startedAt: t0 }
    this.row = { tool, t0, before }
    this.cli = true
    toolStart.set(tool, t0)
    return tool
  }

  /**
   * 压缩完成：有转圈的那一行就收掉、填上前后大小，没有就返回一行新的让 runner 放进回复。
   * 只报了压缩后消息有多大（Claude Code 的 post_tokens）时，加上上次细分里固定占的部分才是整个上下文；
   * 还没有细分就先不填，等细分或下一次用量补上
   */
  done(ev: { before?: number; context?: number; messages?: number }, u: Usage): ToolUse | undefined {
    const row = this.row
    const before = ev.before ?? row?.before ?? (u.context || undefined)
    const fixed = fixedContext(u.snapshot)
    const after = ev.context ?? (ev.messages !== undefined && fixed !== undefined ? ev.messages + fixed : undefined)
    if (after !== undefined) u.context = after
    const tool: ToolUse = row?.tool ?? { kind: 'compact', name: t('压缩上下文'), label: '', detail: '' }
    describeCompaction(tool, before, after, u.window)
    // 整个上下文是 CLI 直接报的才算定了；按细分估的等真实细分再改
    this.pending = ev.context === undefined ? { tool, before } : undefined
    if (!row) return tool
    this.endTool(tool)
    // CLI 自己的自动压缩一轮里可能有好几次，下一次另起一行
    if (this.cli) {
      this.row = undefined
      this.cli = false
    }
    return undefined
  }

  /** 报了新的整个上下文大小：刚压缩完还没填的补上。补了返回 true */
  measured(context: number, window: number) {
    if (!this.pending || context <= 0) return false
    describeCompaction(this.pending.tool, this.pending.before, context, window)
    this.pending = undefined
    return true
  }

  /** 进程结束：CLI 说开始压缩了却没等到压缩完成，不能显示得像压缩成功了 */
  processEnd() {
    if (!this.cli || !this.row) return
    this.row.tool.failed = true
    this.row.tool.label = t('压缩没有完成')
    this.row = undefined
    this.cli = false
  }

  /** 压缩没走正常的压缩（写摘要、裁剪后开新会话）：结果写在这一行上。没有这一行返回 false */
  settle(label: string, output?: string) {
    if (!this.row) return false
    const tool = this.row.tool
    this.endTool(tool)
    delete tool.failed
    tool.label = label
    tool.detail = ''
    if (output) tool.output = output
    return true
  }

  /** 面板发起的压缩跑完了、CLI 没报压缩事件（原生压缩不一定报）：按最后的上下文占用写，没变化就只写压缩前 */
  finishOp(u: Usage) {
    const row = this.row
    if (!row || this.pending || row.tool.compact?.after !== undefined) return
    const after = u.context && u.context !== row.before ? u.context : undefined
    this.endTool(row.tool)
    describeCompaction(row.tool, row.before, after, u.window)
    // 压缩完 CLI 没报新的用量（Codex 手动压缩就是这样）：记下来，下一轮第一次报用量时补上压缩后的大小
    if (after === undefined && row.before !== undefined) row.tool.compact = { before: row.before, awaitAfter: true }
  }
}

/**
 * CLI 报自动压缩抖动（压缩完马上又被一次工具输出填满，CLI 放弃了这一轮）时要不要在原会话里续一轮：
 * 多半是一次读进来太多（并行读几个大文件、cat 大文件），换成分段读取常常就过去了。
 * 只续一次（tried）：再抖动说明上下文上限确实太小，如实报失败；压缩请求本身抖动不续（续了也是同一段历史）；
 * 没有会话可接、预热、用户已经停了都不续
 */
export function shouldRetryThrash(x: {
  detail: string
  pattern?: RegExp
  session: boolean
  prewarm: boolean
  compact: boolean
  aborted: boolean
  tried: boolean
}) {
  return !!x.pattern?.test(x.detail) && x.session && !x.prewarm && !x.compact && !x.aborted && !x.tried
}

/** 压缩抖动后在原会话里续一轮时发给模型的话（提示词，不翻译） */
export const THRASH_RETRY_PROMPT =
  '刚才上下文刚压缩完就又被填满了（一次读进来的内容太多），这一轮被中断了。请从中断的地方继续完成之前的任务，已经做完的不用重做。' +
  '接下来读文件请分段读取（指定行范围，一次只读需要的部分），不要一次并行读多个大文件；命令输出用 head、tail、grep 只看需要的部分，不要 cat 整个大文件。'

/** 压缩抖动最后还是失败时的说明：根子多半是档位的上下文上限比固定开销（系统提示词、工具定义）大不了多少 */
export const thrashHint = (cli: string) =>
  t(
    '· {cli} 刚压缩完上下文就又被填满（自动压缩抖动），常见于档位的上下文上限设得太小、一次读进来的内容又太多。请在设置里把这个档位的上下文调大（Agent 模式建议不低于 {min}），或者让角色分段读取大文件。',
    { cli, min: fmtTokens(MIN_AGENT_CONTEXT) },
  )

/** 压缩抖动、在原会话里续一轮之前写进对话的警告行（不悄悄重试）：续上了由 settleContextNotes 收成已恢复 */
export function thrashNote(x: {
  id: string
  agentId: string
  step: string
  message: string
  raw: string
}): TaskMessage {
  return {
    id: x.id,
    role: 'system',
    agentId: x.agentId,
    step: x.step,
    text: [x.message, '', t('上下文刚压缩完就又满了。正在原会话里续一轮，提醒模型分段读取、只看需要的部分…')].join(
      '\n',
    ),
    tools: [],
    error: true,
    alert: makeAlert('warn', x.raw, 'context'),
    at: new Date().toISOString(),
  }
}

/**
 * 压缩时连压缩请求都超过模型上限：不再请求模型（它照样会拒），把裁剪后的记录当作摘要写进 rewind，
 * 丢掉会话，按压缩成功返回，下一轮开新会话带上（从 runner.ts 拆出来）
 */
export function overflowCompact(x: {
  task: Task
  sessionKey: string
  /** 按预算裁剪好的对话记录 */
  clipped: string
  usage: Usage
  tracker: CompactTracker
  /** 没有压缩那一行时另插的一条说明 */
  msg: (text: string) => TaskMessage
}): string {
  const { task, sessionKey, usage, tracker } = x
  const summary = [t('（原始对话已经超过模型上限，连压缩请求也被拒绝，以下是面板裁剪后保留的记录）'), x.clipped].join(
    '\n\n',
  )
  task.rewind = { session: '', through: null, latest: false, summary }
  delete task.sessions[sessionKey]
  delete task.sessionDirs[sessionKey]
  usage.context = 0
  const note = t('已压缩上下文：对话本身太长，模型连压缩请求都拒绝了，已改为裁剪后开新会话带上（保留最近的内容）')
  // 写在压缩那一行上，不另插一行居中的说明
  if (!tracker.settle(t('对话太长，已裁剪后交给新会话'), note)) task.messages.push(x.msg(note))
  return summary
}
