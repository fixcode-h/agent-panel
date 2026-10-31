import type { AgentResult } from '../../shared/engine.ts'
import type { ContextSnapshot } from '../../shared/context-breakdown.ts'
import type { ToolUse } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'

/** 压缩上下文那一行工具调用：压缩一开始就显示、转圈（像后台命令），压缩完成换成前后大小 */

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

/**
 * 压缩上下文的那一行工具调用，按压缩操作（op 对象）记：网络中断、环境性失败重试时 op 原样传下去，
 * 接着用同一行，不在对话里多出一行压缩
 */
export const compactRows = new WeakMap<object, { tool: ToolUse; t0: number; before?: number }>()

/** CLI 报的上下文细分里固定占的部分（系统提示词、工具定义、说明文件……）：不随压缩变，消息以外的都算 */
const FIXED_SKIP = new Set(['messages', 'since', 'buffer', 'free', 'mcpDeferred', 'systemDeferred'])
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
  tool.label =
    before !== undefined && after !== undefined
      ? t('压缩了 {freed} token（{before} → {after}）', {
          freed: fmtTok(Math.max(0, before - after)),
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
  constructor(private endTool: (x: ToolUse) => void) {}

  /** 面板发起的压缩开始：第一次新建一行（返回它，runner 放进新消息），重试时接着转圈 */
  startOp(op: object & { reason?: string }, before: number | undefined, toolStart: Map<ToolUse, number>) {
    let fresh: ToolUse | undefined
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
  }
}
