/**
 * 任务（对话、工作流执行）的导出、导入和 AI 分析：
 * - 导出成带版本号的 JSON：消息、工作流定义、用到的 Agent、每个节点的结果和统计，去掉会话、命令、本机路径和密钥；
 * - 别人导入后是一个只读的任务，能看完整的执行过程，也能交给 AI 分析；
 * - AI 分析时把导出整理成一份 Markdown 报告附给 Agent，Agent 在回复末尾写 workflow-evolution 块，
 *   给出对工作流、节点、Agent 的修改建议（用户看过差异再应用，不会自动改）和面板框架本身的问题。
 * 服务端和在线演示共用。
 */
import { z } from 'zod'
import { Agent, TaskData, Workflow, type StopReason, type Task, type TaskStep, type TaskTurn } from './schema.ts'
import { includedAgents } from './agent-role.ts'
import { runTree } from './run-usage.ts'
import { idleWaitDuration, stepMs, stepUsage, turnEndOf, waitDuration, withAttachments } from './task.ts'
import { t } from './i18n.ts'
import { promptLangRules, promptLangWord } from './prompt-lang.ts'
import { fmtDuration } from './duration.ts'
import { leadVerdict } from './verdict.ts'

const PEER_REL: Record<string, string> = { parent: '父对话', child: '子对话', peer: '同项目的对话' }

export const TASK_EXPORT_FORMAT = 'agent-panel/task'
export const TASK_EXPORT_VERSION = 1

/** 一个节点的统计：耗时、等待、验收轮数、用量、缓存命中率 */
export interface NodeStat {
  id: string
  parentId: string
  title: string
  kind: TaskStep['kind']
  slot: TaskStep['slot']
  agentId: string
  status: TaskStep['status']
  ms: number
  waitMs: number
  rounds: number
  verdict: TaskStep['verdict']
  interrupted: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  costUsd: number
  /** 改动的文件数 */
  files: number
  /** 输出的字数，太短或太长都值得看一下 */
  outputChars: number
  /** 这个节点里的报错条数 */
  errors: number
}

/** 节点状态的计数 */
export interface StepCounts {
  total: number
  done: number
  failed: number
  skipped: number
  pending: number
}

/**
 * 轮次的结局计数：done 之外的都算没正常结束。unknown 是旧记录（那时只有 status，没记结局），
 * 报告里单独写「原因没记录」，不能混成失败
 */
export interface TurnEndCounts {
  done: number
  /** 导出时还在执行的轮次：它没结束，既不算正常结束也不算「没有正常结束」 */
  running: number
  supersede: number
  user: number
  failed: number
  panel: number
  unknown: number
}

export const NO_TURN_ENDS: TurnEndCounts = {
  done: 0,
  running: 0,
  supersede: 0,
  user: 0,
  failed: 0,
  panel: 0,
  unknown: 0,
}

/** 返工按原因分开计数：只写一个总数看不出是验收没过、节点重跑还是子对话收尾被打回 */
export interface ReworkCounts {
  /** 节点验收不通过后重做 */
  review: number
  /** 同一个节点上一遍跑完之后又从头执行了一遍 */
  rerun: number
  /** 父对话驳回子对话收尾（没能合回原分支），它处理完再来一次 */
  merge: number
  /** 子任务（评审、测试验收）给了「不通过」：以前不算返工，评审连退八次报告还写「返工 0 次」 */
  sub: number
}

export const NO_REWORKS: ReworkCounts = { review: 0, rerun: 0, merge: 0, sub: 0 }

/**
 * 统计里可以相加的那几项：任务自身、它的子对话合计、含子对话的合计都用这一套。
 * 子对话是独立的 Task，只靠 parentTaskId 关联，不在父任务的 usage 里，所以必须单独累加，
 * 否则用户看到的只是父对话自己那一份（几十个子对话的成本整个看不见）。
 */
export interface StatsTotal {
  /** 合计里包含几个任务：自身是 1，含子对话合计是整棵树的个数 */
  tasks: number
  durationMs: number
  /** 等用户确认 / 提问的时间，含在 durationMs 里 */
  waitMs: number
  /** 答完后等用户下一句的时间，不在 durationMs 里（在空闲里扣掉） */
  idleWaitMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  costUsd: number
  steps: StepCounts
  reworks: number
  /** 返工的明细，和 reworks 加起来一致 */
  reworkBy: ReworkCounts
  errors: number
  failedTools: number
  /** 追加要求、对话的轮数（一次 CLI 调用一轮） */
  turns: number
  turnsUnfinished: number
  /** 没正常结束的轮次按结局分开，报告里分类写 */
  turnEnds: TurnEndCounts
}

export const NO_TOTALS: StatsTotal = {
  tasks: 0,
  durationMs: 0,
  waitMs: 0,
  idleWaitMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheHitRate: 0,
  costUsd: 0,
  steps: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0 },
  reworks: 0,
  reworkBy: NO_REWORKS,
  errors: 0,
  failedTools: 0,
  turns: 0,
  turnsUnfinished: 0,
  turnEnds: NO_TURN_ENDS,
}

export interface TaskStats extends Omit<StatsTotal, 'tasks'> {
  /** 记录从头到尾的跨度：第一条到最后一个时间戳 */
  spanMs: number
  /** 跨度里既不算执行也不算等用户的部分：进程退出了、用户在忙别的 */
  idleMs: number
  /**
   * 子对话占用的时长（已从 idleMs 里扣掉，并行时只算一次）。
   * undefined：这个导出入口没算子对话（拿不到子任务记录），空闲里还含着它们的时间
   */
  childBusyMs?: number
  /** 用户消息条数：和轮数不是一个口径，报告里两个都写出来 */
  asks: number
  nodes: NodeStat[]
  /** 它的子对话（含多层）合计：没传子对话时全是 0 */
  children: StatsTotal
  /** 自身 + 子对话合计：这才是这次工作的真实成本 */
  combined: StatsTotal
}

/** 一个任务自身的统计（导出里 stats 的顶层那几项），可以直接与子对话合计相加 */
export function ownTotals(s: Omit<StatsTotal, 'tasks'>): StatsTotal {
  // 逐项取：传进来的可能是整个 TaskStats（带 nodes/children/combined），别把多余字段带进合计
  return {
    tasks: 1,
    durationMs: s.durationMs,
    waitMs: s.waitMs,
    idleWaitMs: s.idleWaitMs,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheHitRate: s.cacheHitRate,
    costUsd: s.costUsd,
    steps: s.steps,
    reworks: s.reworks,
    reworkBy: s.reworkBy,
    errors: s.errors,
    failedTools: s.failedTools,
    turns: s.turns,
    turnsUnfinished: s.turnsUnfinished,
    turnEnds: s.turnEnds,
  }
}

/** 两组统计相加；命中率按合计后的输入和缓存命中重算，不能把两个百分比直接相加 */
export function addTotals(a: StatsTotal, b: StatsTotal): StatsTotal {
  const inputTokens = a.inputTokens + b.inputTokens
  const cacheReadTokens = a.cacheReadTokens + b.cacheReadTokens
  return {
    tasks: a.tasks + b.tasks,
    durationMs: a.durationMs + b.durationMs,
    waitMs: a.waitMs + b.waitMs,
    idleWaitMs: a.idleWaitMs + b.idleWaitMs,
    inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens,
    cacheHitRate: cacheHitRate({ inputTokens, cacheReadTokens }),
    costUsd: a.costUsd + b.costUsd,
    steps: {
      total: a.steps.total + b.steps.total,
      done: a.steps.done + b.steps.done,
      failed: a.steps.failed + b.steps.failed,
      skipped: a.steps.skipped + b.steps.skipped,
      pending: a.steps.pending + b.steps.pending,
    },
    reworks: a.reworks + b.reworks,
    reworkBy: {
      review: a.reworkBy.review + b.reworkBy.review,
      rerun: a.reworkBy.rerun + b.reworkBy.rerun,
      merge: a.reworkBy.merge + b.reworkBy.merge,
      sub: (a.reworkBy.sub ?? 0) + (b.reworkBy.sub ?? 0),
    },
    errors: a.errors + b.errors,
    failedTools: a.failedTools + b.failedTools,
    turns: a.turns + b.turns,
    turnsUnfinished: a.turnsUnfinished + b.turnsUnfinished,
    turnEnds: {
      done: a.turnEnds.done + b.turnEnds.done,
      running: a.turnEnds.running + b.turnEnds.running,
      supersede: a.turnEnds.supersede + b.turnEnds.supersede,
      user: a.turnEnds.user + b.turnEnds.user,
      failed: a.turnEnds.failed + b.turnEnds.failed,
      panel: a.turnEnds.panel + b.turnEnds.panel,
      unknown: a.turnEnds.unknown + b.turnEnds.unknown,
    },
  }
}

/**
 * 一组任务（父对话分出的子对话，含多层）的统计合计。
 * 传进来的每份只算它自身的 usage（它自己派出的子任务已经记在它的 usage 里），不会重复累加；
 * 子对话的报错要靠 messages 算，所以调用方要取完整任务，不能只用摘要。
 */
export function descendantTotals(tasks: Task[], now = Date.now()): StatsTotal {
  return tasks.reduce((acc, tk) => addTotals(acc, ownTotals(taskStats(tk, now))), NO_TOTALS)
}

/**
 * 缓存命中率：命中缓存的 token 占输入合计的比例。
 * 输入统一按「含缓存」记（见 parser 的 usage 换算），所以分母就是 inputTokens；
 * 封顶到 100%，口径真的对不上时宁可显示 100% 也不把 3348% 这种数字交给用户。
 */
export function cacheHitRate(u: { inputTokens: number; cacheReadTokens: number }) {
  const total = u.inputTokens || 0
  if (!total) return 0
  return Math.min(1, Math.max(0, Math.round((u.cacheReadTokens / total) * 1000) / 1000))
}

/**
 * 缓存命中数超过了输入合计：说明分子分母不是一个口径（例如某个 CLI 的 input 不含缓存、没换算）。
 * 封顶本身会把数字压成 100% 看不出来，报告里要单独提示一句，否则错误口径会一直隐身。
 */
export function cacheMismatch(u: { inputTokens: number; cacheReadTokens: number }) {
  const total = u.inputTokens || 0
  return total > 0 && (u.cacheReadTokens || 0) > total * 1.05
}

/** 失败的工具调用：命令非零退出、读取失败、编辑冲突都会标上 failed */
const failedToolsOf = (task: Task, step?: string) =>
  task.messages
    .filter((m) => (step === undefined ? true : m.step === step))
    .reduce((n, m) => n + m.tools.filter((x) => x.failed).length, 0)

/** 算时间跨度用得到的字段：创建时间、消息、轮次、节点的时间戳和状态 */
type SpanRecord = {
  createdAt: string
  messages: { at?: string }[]
  turns?: { startedAt: string; endedAt?: string; status?: string }[]
  steps?: { startedAt: string; endedAt?: string; status?: string }[]
  /** 正在等确认 / 正在等下一句的开始时间：跨度要盖住这段，不然会报出「跨度 5m，等你处理 3h55m」 */
  waitStartedAt?: string
  idleWaitAt?: string
  /** 任务自己的状态：已经停下的记录里残留的「正在等」只是没清掉，不能再按现在算 */
  status?: string
}

type Span = { start: number; end: number }

/**
 * 一段记录（轮次 / 节点）的起止时间：结束了用结束时间，还在跑的给得出「现在」时按现在算。
 * 还没收尾的轮次没有 endedAt，只取开始时间的话窗口会退化成零长，算忙时会漏掉整段。
 */
function spanOf(x: { startedAt: string; endedAt?: string; status?: string }, now: number) {
  const start = Date.parse(x.startedAt)
  const ended = Date.parse(x.endedAt ?? '')
  const end = Number.isFinite(ended) ? ended : now && x.status === 'running' ? now : NaN
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : undefined
}

/**
 * 记录从头到尾的窗口（毫秒时间戳）：创建、消息、轮次、节点里最早和最晚的时间。
 * 不用 updatedAt：导入的任务会把它改成导入时间，跨度会凭空变长。
 * now：还在跑的轮次、节点按它算结束时间，不给时只认已经记下的时间戳。
 */
export function recordWindow(rec: SpanRecord, now = 0) {
  const ats: number[] = [Date.parse(rec.createdAt)]
  for (const m of rec.messages) ats.push(Date.parse(m.at ?? ''))
  for (const t of rec.turns ?? []) {
    const w = spanOf(t, now)
    ats.push(Date.parse(t.startedAt), w ? w.end : Date.parse(t.endedAt ?? ''))
  }
  for (const s of rec.steps ?? []) {
    const w = spanOf(s, now)
    ats.push(Date.parse(s.startedAt), w ? w.end : Date.parse(s.endedAt ?? ''))
  }
  // 还在等的这一段：任务还在跑时算到现在（跨度要盖住它），已经停下的只认开始那一刻
  for (const x of [rec.waitStartedAt, rec.idleWaitAt])
    if (x) ats.push(now && (rec.status === undefined || rec.status === 'running') ? now : Date.parse(x))
  const ok = ats.filter(Number.isFinite)
  if (!ok.length) return { start: 0, end: 0 }
  return { start: Math.min(...ok), end: Math.max(...ok) }
}

/** 记录的跨度（毫秒）：窗口的大小；now 给了就把还在跑的轮次、节点算到现在，导出执行中的任务时跨度才不小 */
export function recordSpan(rec: SpanRecord, now = 0) {
  const w = recordWindow(rec, now)
  return Math.max(0, w.end - w.start)
}

/** 几个时间段裁进 [from, to] 再合并成不重叠的区间：并行/重叠的部分只算一次 */
function mergeRanges(spans: Span[], from: number, to: number): Span[] {
  const list = spans
    .map((x) => ({ start: Math.max(x.start, from), end: Math.min(x.end, to) }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const x of list) {
    const last = out.at(-1)
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end)
    else out.push({ ...x })
  }
  return out
}

/** 合并后这些时间段的合计时长（毫秒） */
function rangesMs(list: Span[]) {
  return list.reduce((n, x) => n + Math.max(0, x.end - x.start), 0)
}

/**
 * 名下子对话（含多层）在父记录跨度里占用了多久（毫秒）——以前这段整个被算成父对话的「空闲」，
 * 用户看到过两个一模一样的 3h48m。
 * 子对话窗口先裁进父记录的跨度、并行/重叠的合并成一次；和父自己执行时间的重叠由 taskStats 统一夹
 * （`min(子对话占用, 跨度 - 执行)`）。不能按轮次时间窗逐段相减：对话轮从开始到被停止一直是 running，
 * 会把「答完等下一句」那段也算成父在跑，子对话占用就被减成 0，用户投诉的现象原样保留。
 */
export function childBusyMs(root: SpanRecord, kids: SpanRecord[], now = 0) {
  const win = recordWindow(root, now)
  if (win.end <= win.start || !kids.length) return 0
  const kidSpans: Span[] = []
  for (const k of kids) {
    const w = recordWindow(k, now)
    if (w.end > w.start) kidSpans.push(w)
  }
  return rangesMs(mergeRanges(kidSpans, win.start, win.end))
}

/**
 * 轮次按结局分开计数：没正常结束的轮次以前混成一个数，看不出是被新消息接管、用户停的还是面板收掉的。
 * reason 是任务的 stopReason：面板重启、预热带起来这些轮次不经过 endTurn（落盘时直接改 status），
 * 没有 end 字段，只能靠它兜底，否则最常见的「面板重启」会全变成「原因没记录」。
 */
export function turnEndCounts(turns: TaskTurn[], reason?: StopReason): TurnEndCounts {
  const c = { ...NO_TURN_ENDS }
  // 兜底只能用最后一次停下的原因，而它只解释「被这次停止一起收掉」的那几轮：
  // 旧记录里每轮停下的原因各不相同，统一按最后一个算会把「被新消息接管」说成「用户停止」
  const ends = turns.map((x) => Date.parse(x.endedAt ?? '')).filter(Number.isFinite)
  const lastEnd = ends.length ? Math.max(...ends) : 0
  for (const x of turns) {
    if (x.status === 'running') {
      // 导出时还没跑完：既不算正常结束，也还没「没有正常结束」，报告里单独写「还在执行」
      c.running++
      continue
    }
    if (x.status === 'done') {
      c.done++
      continue
    }
    // 自己记下的结局优先：status 已经说明失败的按失败算，停止的看任务停下来的原因
    const last = !!lastEnd && Date.parse(x.endedAt) === lastEnd
    const fallback =
      x.status === 'failed' ? 'failed' : x.status === 'stopped' && last ? turnEndOf('stopped', reason) : undefined
    const end = x.end ?? fallback
    // 手改过的数据里可能是别的值：认不出就算原因没记录，别给计数对象加多余的键
    if (end && end !== 'done' && end in c) c[end]++
    else c.unknown++
  }
  return c
}

/** 父对话驳回子对话收尾：收尾结果那条消息标了 failed；旧记录还没有 peer 字段，按正文认 */
const mergeRejects = (task: Task) =>
  task.messages.filter(
    (m) => (m.peer?.kind === 'merge' && m.peer.failed) || m.text.startsWith('【父对话收尾】没能合回'),
  ).length

/** 返工按原因分开：验收重做、同一节点重跑、子对话收尾被驳回来重做 */
export function reworkCounts(task: Task): ReworkCounts {
  return {
    // reviews 是验收不通过那一刻累加的，节点重跑清零 rounds 也不会丢；旧记录没有这个字段，退回按 rounds 反推
    review: task.steps.reduce(
      (n, s) => n + Math.max(s.reviews ?? 0, Math.max(0, s.rounds - (s.verdict === 'pass' ? 1 : 0))),
      0,
    ),
    rerun: task.steps.reduce((n, s) => n + Math.max(0, s.reruns ?? 0), 0),
    merge: mergeRejects(task),
    // 结论按评审门禁同一种读法（首行优先），派出去的子任务只有评审、测试验收会写结论
    sub: task.steps.filter((s) => s.slot === 'sub' && s.status === 'done' && leadVerdict(s.output) === 'fail').length,
  }
}

/**
 * 一个任务的统计。childBusy：子对话在它的跨度里在跑的时长（见 childBusyMs），
 * 传进来就从空闲里扣掉，不传时按没有子对话在跑算
 */
export function taskStats(
  task: Task,
  now = Date.now(),
  children: StatsTotal = NO_TOTALS,
  /** 子对话占用的时长；不传表示这个入口算不出（见 TaskStats.childBusyMs） */
  childBusy?: number,
): TaskStats {
  const errorsOf = (step: string) => task.messages.filter((m) => m.error && m.step === step).length
  const nodes = task.steps.map((s): NodeStat => {
    const u = stepUsage(s)
    return {
      id: s.id,
      parentId: s.parentId,
      title: s.title,
      kind: s.kind,
      slot: s.slot,
      agentId: s.agentId,
      status: s.status,
      ms: stepMs(s, now),
      waitMs: s.waitMs ?? 0,
      rounds: s.rounds,
      verdict: s.verdict,
      interrupted: s.interrupted,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheHitRate: cacheHitRate(u),
      costUsd: u.costUsd,
      files: s.changes.length,
      outputChars: s.output.length,
      errors: errorsOf(s.id) + failedToolsOf(task, s.id),
    }
  })
  const count = (st: TaskStep['status']) => task.steps.filter((s) => s.status === st).length
  const u = task.usage
  // 还在执行的这一段没结算进 runMs / waitMs：不算进来，导出的报告会写成「执行 0s、空闲一整段」，
  // 和界面上的「总耗时」（taskDuration 含 live）也对不上
  const durationMs = (task.runMs ?? 0) + (task.runStartedAt ? Math.max(0, now - Date.parse(task.runStartedAt)) : 0)
  const waitMs = waitDuration(task, now)
  // 旧记录（加 idleWaitMs 之前）把「答完等下一句」也算在 waitMs 里：超出执行时间的那部分只能是它，
  // 否则报告会写出「等你确认 23h55m 已含在执行 8m 里」，同一段又算进空闲，用户投诉的就是这句
  const overWait = Math.max(0, waitMs - durationMs)
  // 取大不取和：新记录里 idleWaitMs 已经记过「等下一句」，再和 overWait 相加会把同一段算两遍
  const idleWaitMs = Math.max(idleWaitDuration(task, now), overWait)
  const confirmWaitMs = Math.max(0, Math.min(waitMs, durationMs))
  // 还在跑的轮次、节点要算到现在；没有轮次/节点的旧记录时间戳不全，跨度按执行时间兜底，不能比执行还短
  const spanMs = Math.max(recordSpan(task, now), durationMs)
  const reworkBy = reworkCounts(task)
  const turnEnds = turnEndCounts(task.turns ?? [], task.stopReason)
  const own = ownTotals({
    durationMs,
    waitMs: confirmWaitMs,
    idleWaitMs,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheHitRate: cacheHitRate(u),
    costUsd: u.costUsd,
    steps: {
      total: task.steps.length,
      done: count('done'),
      failed: count('failed'),
      skipped: count('skipped'),
      pending: count('pending') + count('running'),
    },
    reworks: reworkBy.review + reworkBy.rerun + reworkBy.merge + reworkBy.sub,
    reworkBy,
    errors: task.messages.filter((m) => m.error).length + failedToolsOf(task),
    failedTools: failedToolsOf(task),
    turns: task.turns?.length ?? 0,
    // 没正常结束的轮次 = 各种结局相加，和 turnEnds 对得上（旧记录落在 unknown 里）
    turnsUnfinished: turnEnds.supersede + turnEnds.user + turnEnds.failed + turnEnds.panel + turnEnds.unknown,
    turnEnds,
  })
  const { tasks: _tasks, ...self } = own
  // 空闲 = 跨度里除了本任务在跑之外的部分。等你处理的时间已经在 durationMs 里（等确认、提问时
  // runMs 不清空），再减一次就重复扣了；等下一句那段本来就在空闲里，报告的「其中等你处理」会写出来
  // 空闲 = 跨度里本任务没在跑的部分；答完后等下一句本来就在空闲里（报告里写成「其中」），等你确认的那部分在执行里
  const freeMs = Math.max(0, spanMs - durationMs)
  const busyMs = childBusy === undefined ? undefined : Math.max(0, Math.min(childBusy, freeMs))
  return {
    ...self,
    spanMs,
    idleMs: Math.max(0, freeMs - (busyMs ?? 0)),
    childBusyMs: busyMs,
    // 父对话、别的对话交过来的消息有 peer：不是用户说的，不算进「用户消息」
    asks: task.messages.filter((m) => m.role === 'user' && !m.peer).length,
    nodes,
    children,
    combined: addTotals(own, children),
  }
}

const SECRET = '[已移除]'
/** 常见的密钥格式：各家 API key、GitHub token、AWS key、Slack token */
const KEY_RE =
  /\b(?:sk-ant-[\w-]{16,}|sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|xox[abprs]-[\w-]{10,}|hf_[A-Za-z0-9]{20,})\b/g
const BEARER_RE = /\b(Bearer\s+)[\w.~+/=-]{16,}/gi
/** key=value、"key": "value" 这种写法里名字像密钥的值 */
const ASSIGN_RE =
  /((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|auth[_-]?token|authorization)["']?\s*[:=]\s*["']?)(?!\[已移除|Bearer\s)[^\s"',;]{6,}/gi

/** 去掉文字里的密钥 */
export function redactSecrets(s: string) {
  return s.replace(KEY_RE, SECRET).replace(BEARER_RE, `$1${SECRET}`).replace(ASSIGN_RE, `$1${SECRET}`)
}

/** 递归处理所有字符串 */
function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as T
  if (Array.isArray(v)) return v.map(redactDeep) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T
  return v
}

/** 任务里用到的 Agent：对话的、各节点的、工作流的主 Agent，连同它们引入的 */
export function taskAgents(task: Pick<Task, 'agentId' | 'steps' | 'messages' | 'workflows'>, agents: Agent[]) {
  const ids = new Set<string>([
    task.agentId,
    ...task.steps.map((s) => s.agentId),
    ...task.messages.map((m) => m.agentId),
  ])
  for (const w of task.workflows) {
    ids.add(w.mainAgentId)
    for (const m of w.members) ids.add(m.agentId)
    for (const f of w.flows)
      for (const n of f.nodes) {
        ids.add(n.agentId)
        for (const s of n.steps) ids.add(s.agentId)
      }
  }
  for (const id of [...ids]) {
    const a = agents.find((x) => x.id === id)
    if (a) for (const x of includedAgents(a, agents)) ids.add(x.agent.id)
  }
  return agents.filter((a) => a.id && ids.has(a.id))
}

/** 导出文件里的任务：去掉只在本机有意义的字段（会话、命令、项目、独立分支和等待中的请求） */
const ExportedTask = TaskData.omit({
  projectId: true,
  sessions: true,
  sessionCli: true,
  sessionDir: true,
  wantsWorktree: true,
  rewind: true,
  command: true,
  baseline: true,
  baseRef: true,
  requests: true,
  worktree: true,
  budgetFrom: true,
  archived: true,
  imported: true,
  // 这些是运行中的临时状态，导入后都按空闲算
  working: true,
  turnDoneAt: true,
  awaitingUser: true,
  prewarming: true,
}).extend({
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 导出时这个任务还在跑：报告里说明这是当时的快照，不至于让人以为统计漏了一段 */
  exportedWhileRunning: z.boolean().default(false),
})
export type ExportedTask = z.infer<typeof ExportedTask>

/**
 * 包里的子对话：和父任务一样是去掉本机字段的任务，另外带上自己的 id，
 * 好让更深一层的子对话用 `parentTaskId` 指回它（`parentTaskId` 为空表示直接挂在这个包的父任务下）。
 */
const ExportedChild = ExportedTask.extend({ id: z.string(), parentTaskId: z.string().default('') })
export type ExportedChild = z.infer<typeof ExportedChild>

export const TaskExport = z.object({
  format: z.literal(TASK_EXPORT_FORMAT),
  version: z.literal(TASK_EXPORT_VERSION),
  exportedAt: z.string(),
  /** 导出它的面板版本，方便排查格式问题 */
  app: z.string().default(''),
  task: ExportedTask,
  /**
   * 这个任务分出的所有子对话（含多层），平铺在这个数组里，靠 `parentTaskId` 连回父任务或更上层的子对话。
   * 旧版本的包没有这个字段，读成空数组
   */
  children: z.array(ExportedChild).default([]),
  agents: z.array(Agent).default([]),
  /** 导出时算好的统计，分析时不用再算；导入时会重新算 */
  stats: z.unknown().optional(),
})
export type TaskExport = z.infer<typeof TaskExport>

/** 导出包的体积上限：消息文件可能有几百 MB，一个 JSON 装不下也不该装，导出前先拦下来 */
export const TASK_EXPORT_MAX_BYTES = 50 * 1024 * 1024

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

/** 导出包的体积（UTF-8 字节）：服务端和浏览器都按这个算，判断能不能放进一个文件 */
export function exportBytes(bundle: TaskExport): number {
  return new TextEncoder().encode(JSON.stringify(bundle)).length
}

/** 超过上限就报错：与其生成一个打不开的几百 MB 文件，不如让用户先精简子对话 */
export function checkExportSize(bundle: TaskExport): number {
  const bytes = exportBytes(bundle)
  if (bytes > TASK_EXPORT_MAX_BYTES)
    throw new Error(
      t('这次导出连同子对话有 {size}，超过了 {max} 的上限。可以先删掉不需要的子对话，或者单独导出其中的子对话。', {
        size: fmtBytes(bytes),
        max: fmtBytes(TASK_EXPORT_MAX_BYTES),
      }),
    )
  return bytes
}

/** 任务在导出文件里的样子：去掉只在本机有意义的字段，运行中的临时状态都按导出这一刻收尾 */
function exportedBody(task: Task, now: Date): ExportedTask {
  const {
    id: _id,
    projectId: _p,
    sessions: _s,
    sessionCli: _sc,
    sessionDir: _sd,
    wantsWorktree: _ww,
    rewind: _r,
    command: _c,
    baseline: _b,
    baseRef: _br,
    requests: _rq,
    worktree: _w,
    budgetFrom: _bf,
    archived: _a,
    imported: _i,
    ...rest
  } = task
  const at = now.toISOString()
  return {
    ...rest,
    // 还在执行的任务导出的是当时的样子：状态和还在跑的轮次、节点都按导出这一刻收尾。
    // 不收尾的话，导入后再算统计（recordSpan 会拿「现在」当还在跑的结束时间）跨度会一直涨
    status: rest.status === 'running' ? 'stopped' : rest.status,
    exportedWhileRunning: rest.status === 'running',
    // live 的执行 / 等待先结算进累计值再清开始时间：只清不结算，导入后执行时长会凭空少一截
    runMs: (task.runMs ?? 0) + (task.runStartedAt ? Math.max(0, now.getTime() - Date.parse(task.runStartedAt)) : 0),
    runStartedAt: '',
    waitMs: waitDuration(task, now.getTime()),
    waitStartedAt: '',
    idleWaitMs: idleWaitDuration(task, now.getTime()),
    // 已经停下的记录里残留的 idleWaitAt 是「等待到此为止」的时间点，清掉跨度会前后不一致；
    // 还在跑的那份已经结算进 idleWaitMs，清掉才不会带着一个会继续长的开始时间
    idleWaitAt: rest.status === 'running' ? '' : (task.idleWaitAt ?? ''),
    turns: rest.turns.map((x) =>
      x.status === 'running'
        ? { ...x, status: 'stopped' as const, endedAt: x.endedAt || at, end: 'panel' as const }
        : x,
    ),
    steps: rest.steps.map((s) => ({
      ...s,
      command: [],
      waitStartedAt: '',
      ...(s.status === 'running' ? { status: 'pending' as const, endedAt: s.endedAt || at } : {}),
    })),
    // 附件只留名字和大小：路径是本机的，文件也不在导出里（路径字段不能为空，填文件名）
    messages: rest.messages.map((m) =>
      m.attachments ? { ...m, attachments: m.attachments.map((a) => ({ ...a, path: a.name })) } : m,
    ),
  }
}
/** 把任务整理成导出文件的内容 */
export function exportTask(
  task: Task,
  agents: Agent[],
  app = '',
  now = new Date(),
  children: StatsTotal = NO_TOTALS,
  /** 子对话占用的时长：只有拿得到整棵树记录的导出入口（exportTaskTree）能算，其余入口留空 */
  childBusy?: number,
): TaskExport {
  const body = exportedBody(task, now)
  // 导入的任务再导出时，用导入时带来的 Agent
  const pool = importedAgentsPool([task], agents)
  const used = taskAgents(task, pool).map((a) => ({ ...a, categoryId: '', tags: [] }))
  return redactDeep({
    format: TASK_EXPORT_FORMAT,
    version: TASK_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    app,
    task: body,
    children: [],
    agents: used,
    // 用 steps 的副本：算统计时 stepUsage 会给缺省值补上 usage，别把导出过程写回内存里的任务
    // 统计按导出后的记录体算：和包里存的任务保持一致，导出、导入、AI 分析三处数字不会打架
    stats: taskStats({ ...task, ...body }, now.getTime(), children, childBusy),
  })
}

/** 可用的 Agent：本机的，加上这些任务导出时带来的（导入过的任务再导出，要能找回对方那边自定义的角色） */
function importedAgentsPool(tasks: Task[], agents: Agent[]) {
  const pool = [...agents]
  for (const tk of tasks) for (const a of tk.imported?.agents ?? []) if (!pool.some((x) => x.id === a.id)) pool.push(a)
  return pool
}

/**
 * 把任务连同它分出的所有子对话（含多层）整理成一个导出文件。
 * 子对话平铺在 `children` 里，`parentTaskId` 指向包内的上层任务（空表示直接挂在父任务下）；
 * 子任务（`steps` 里 `slot: 'sub'` 的）本来就在各自的任务里，跟着一起走，不用另外收集。
 */
export function exportTaskTree(root: Task, all: Task[], agents: Agent[], app = '', now = new Date()): TaskExport {
  // 按 parentTaskId 逐层往下找，同一个任务只收一次（两个父对话共用一个子对话时不会重复）
  const kids = runTree(root, all).filter((x) => x.id !== root.id)
  const pool = importedAgentsPool([root, ...kids], agents)
  // 子对话在父记录跨度里跑了多久：报告里从父对话的空闲里扣掉，同一段时间不再重复计时
  const bundle = exportTask(
    root,
    pool,
    app,
    now,
    descendantTotals(kids, now.getTime()),
    childBusyMs(root, kids, now.getTime()),
  )
  bundle.children = kids.map((k) => ({
    ...exportedBody(k, now),
    id: k.id,
    // 直接挂在父任务下的写空：父任务的 id 不出现在包里（导入时会重新分配），指向它没法还原
    parentTaskId: k.parentTaskId === root.id ? '' : k.parentTaskId,
  }))
  // 子对话用到的 Agent 也带上：本机没有这些角色时，导入的一方还能看到名字和设定
  const extra: Agent[] = []
  for (const k of kids)
    for (const a of taskAgents(k, pool))
      if (!bundle.agents.some((x) => x.id === a.id) && !extra.some((x) => x.id === a.id)) extra.push(a)
  if (extra.length) bundle.agents = [...bundle.agents, ...extra.map((a) => ({ ...a, categoryId: '', tags: [] }))]
  // 导出前整体再去一遍密钥（子对话的内容还没走过这一步），已去掉的部分不会被再改
  return redactDeep(bundle)
}

export const exportFileName = (title: string) =>
  `${title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'task'}.task.json`

/** 读导出文件：格式不对时给出能看懂的原因 */
export function parseTaskExport(raw: unknown): TaskExport {
  if (!raw || typeof raw !== 'object') throw new Error(t('不是有效的 JSON 文件'))
  const o = raw as Record<string, unknown>
  if (o.format !== TASK_EXPORT_FORMAT) throw new Error(t('这不是 Agent 面板导出的任务文件'))
  if (typeof o.version === 'number' && o.version > TASK_EXPORT_VERSION)
    throw new Error(t('这个文件是更新版本的面板导出的，请先升级面板'))
  const p = TaskExport.safeParse(raw)
  if (!p.success) throw new Error(t('任务文件的格式不对：{path}', { path: p.error.issues[0]?.path.join('.') ?? '' }))
  return p.data
}

/**
 * 导入：建一个只读的任务。Agent 不往本机的 Agent 列表里加，只存在任务里给页面显示名字；
 * 再去一遍密钥，免得别人导出时用的是旧版本、没去干净
 */
export function importTask(bundle: TaskExport, projectId: string, id: string, now = new Date().toISOString()): Task {
  const b = redactDeep(bundle)
  // 导出的任务本身可能是别人那边的子对话：本机没有它的父对话，导入后要当顶层任务才能看到
  return importedTask(b.task, b, projectId, id, now, '', '')
}

/** 一个导出文件里的任务 → 本机的只读任务（`parentTaskId` / `rootTaskId` 由调用方按新树回填） */
function importedTask(
  body: ExportedTask,
  bundle: Pick<TaskExport, 'exportedAt' | 'app' | 'agents'>,
  projectId: string,
  id: string,
  now: string,
  parentTaskId: string,
  rootTaskId: string,
): Task {
  return {
    ...body,
    id,
    parentTaskId,
    rootTaskId,
    projectId,
    sessions: {},
    wantsWorktree: false,
    command: [],
    baseline: {},
    baseRef: '',
    requests: [],
    worktree: null,
    working: false,
    turnDoneAt: '',
    awaitingUser: false,
    prewarming: false,
    simulated: body.simulated,
    imported: { at: now, exportedAt: bundle.exportedAt, app: bundle.app, agents: bundle.agents },
    createdAt: body.createdAt,
    updatedAt: now,
  }
}

/**
 * 导入整个包：父任务连同它的子对话一起建成只读任务，父在前、子在后（`ids` 由调用方生成，第一个给父任务）。
 * 子对话的 `parentTaskId` / `rootTaskId` 指向本机新分配的 id，父子结构和不导入时一样；
 * 步骤 id 原样保留，所以消息里 `spawned` 引用的子任务、节点里的输出都对得上。
 * 子对话的父不在包里（导出后父对话被删了）时挂到父任务下，不让它变成看不见的孤儿。
 */
export function importTaskTree(
  bundle: TaskExport,
  projectId: string,
  ids: string[],
  now = new Date().toISOString(),
): Task[] {
  const [rootId] = ids
  if (!rootId) throw new Error(t('缺少导入任务的 id'))
  const b = redactDeep(bundle)
  const root = importedTask(b.task, b, projectId, rootId, now, '', '')
  // 同一个子对话在包里出现两次时只收一次（导出时已经去过重，这里防手改过的包）
  const seen = new Set<string>()
  const left = b.children.filter((c) => {
    if (!c.id || seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
  // 父先子后：父对话还没分配新 id 的子对话先跳过，这一轮分不下去的（父不在包里）挂到父任务下
  const newIds = new Map<string, string>()
  /** 依次分配新 id：第一个给父任务，之后按父先子后的顺序；调用方给的 id 不够时补一个不会重复的 */
  const nextId = () => ids[newIds.size + 1] || `${rootId}-${newIds.size + 1}`
  const order: { child: ExportedChild; parentTaskId: string }[] = []
  let placed = left.length > 0
  while (left.length && placed) {
    placed = false
    for (let i = left.length - 1; i >= 0; i--) {
      const child = left[i]
      const parent = child.parentTaskId ? newIds.get(child.parentTaskId) : rootId
      if (parent === undefined) continue
      newIds.set(child.id, nextId())
      order.push({ child, parentTaskId: parent })
      left.splice(i, 1)
      placed = true
    }
  }
  for (const child of left) {
    newIds.set(child.id, nextId())
    order.push({ child, parentTaskId: rootId })
  }
  // 父任务在前，子对话在后：子对话的 parentTaskId 指的就是这里分配的新 id
  return [
    root,
    ...order.map(({ child, parentTaskId }) =>
      importedTask(child, b, projectId, newIds.get(child.id)!, now, parentTaskId, rootId),
    ),
  ]
}

/** 页面显示导入的任务时，本机没有的 Agent 用导入时带来的 */
export function withImportedAgents(agents: Agent[], task: Pick<Task, 'imported'> | null | undefined) {
  const extra = task?.imported?.agents.filter((a) => !agents.some((x) => x.id === a.id)) ?? []
  return extra.length ? [...agents, ...extra] : agents
}

// ---- AI 分析 ----

export const EVOLUTION_LANG = 'workflow-evolution'

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const pct = (r: number) => `${Math.round(r * 100)}%`
/**
 * 记录里的时间统一用本地时间：表头原来直接切 ISO 串（UTC），正文却用 getHours()，
 * 同一份记录里能差出几个小时，读的人会以为任务跑了很久。
 */
const localTime = (iso: string) => {
  const d = new Date(iso)
  if (!iso || !Number.isFinite(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（后面省略 ${s.length - n} 字）` : s)

/** 轮次结局在报告里的说法，和 schema 的 TurnEnd 一一对应 */
const TURN_END_TEXT: Record<keyof TurnEndCounts, string> = {
  done: '正常结束',
  running: '还在执行',
  supersede: '被新消息接管',
  user: '用户停止',
  failed: '失败',
  panel: '面板停止',
  unknown: '原因没记录',
}

/** 一次执行整理成 Markdown：统计、工作流定义、每个节点的结果、报错、用户的要求 */
export function taskReport(b: TaskExport, maxOutput = 4000) {
  const tk = b.task
  // 旧导出的 stats 没有跨度和空闲字段，按记录里的时间戳现算补齐，不把 undefined 写进报告
  const computed = taskStats({ ...tk, id: '', projectId: '' } as unknown as Task)
  const raw = (b.stats ?? {}) as Partial<TaskStats>
  const st: TaskStats = {
    ...computed,
    ...raw,
    spanMs: raw.spanMs ?? computed.spanMs,
    idleMs: raw.idleMs ?? computed.idleMs,
    asks: raw.asks ?? computed.asks,
    children: raw.children ?? computed.children,
    combined: raw.combined ?? computed.combined,
  }
  const own = ownTotals(st)
  const kids = st.children?.tasks ? st.children : NO_TOTALS
  const all = st.combined?.tasks ? st.combined : addTotals(own, kids)
  // 没正常结束的轮次按结局分开写：只有和总数对得上时才拆，旧导出缺结局字段时只写总数
  const ends = st.turnEnds ?? NO_TURN_ENDS
  const ended = ['supersede', 'user', 'failed', 'panel', 'unknown'] as const
  const endSum = ended.reduce((n, k) => n + ends[k], 0)
  const endText = ended
    .filter((k) => ends[k])
    .map((k) => `${TURN_END_TEXT[k]} ${ends[k]} 轮`)
    .join('、')
  const turnParts: string[] = []
  if (st.turnsUnfinished)
    turnParts.push(
      `${st.turnsUnfinished} 轮没有正常结束${endSum === st.turnsUnfinished && endText ? `：${endText}` : ''}`,
    )
  // 导出时还在跑的那几轮单独说，别混进「没有正常结束」
  if (ends.running) turnParts.push(`${ends.running} 轮还在执行`)
  const unfinished = turnParts.length ? `（其中 ${turnParts.join('；')}）` : ''
  // 返工按原因分开写：只写一个总数看不出是验收没过、节点重跑还是子对话收尾被打回
  const by = st.reworkBy ?? NO_REWORKS
  const reworkParts = [
    by.review ? `验收不通过 ${by.review} 次` : '',
    by.rerun ? `同一节点重跑 ${by.rerun} 次` : '',
    by.merge ? `子对话收尾被驳回 ${by.merge} 次` : '',
    by.sub ? `子任务验收不通过 ${by.sub} 次` : '',
  ].filter(Boolean)
  const reworkText = st.reworks && reworkParts.length ? `（${reworkParts.join('、')}）` : ''
  // 合计行也要分类：子对话收尾被驳回那条消息写在子对话里，只写总数就看不到
  const allBy = all.reworkBy ?? NO_REWORKS
  const allReworkParts = [
    allBy.review ? `验收不通过 ${allBy.review} 次` : '',
    allBy.rerun ? `同一节点重跑 ${allBy.rerun} 次` : '',
    allBy.merge ? `子对话收尾被驳回 ${allBy.merge} 次` : '',
    allBy.sub ? `子任务验收不通过 ${allBy.sub} 次` : '',
  ].filter(Boolean)
  const allReworkText = all.reworks && allReworkParts.length ? `（${allReworkParts.join('、')}）` : ''
  // 空闲的口径要和实算的对得上：没算子对话占用的入口（AI 分析那份导出）不能写成「同一段时间只算一处」
  // 空闲 = 本任务没在跑、子对话也没在跑的时候；等你确认的时间算在执行里，等你回下一句的时间算在空闲里。
  // 各段互不重叠：执行 + 等你回下一句 + 子对话占用 + 空闲 = 跨度
  const idleNote = !kids.tasks
    ? '空闲是本任务没在跑的时候（含你答完后等下一句的时间）。'
    : st.childBusyMs === undefined
      ? '这条记录没算子对话的占用，空闲里可能还含它们的时间。'
      : st.childBusyMs
        ? '空闲是本任务和名下子对话都没在跑的时候；子对话占用含它们自己在等的时候。'
        : '空闲是本任务和名下子对话都没在跑的时候；名下子对话没有另外占掉这条记录里的时间。'
  const agentName = (id: string) => (id ? (b.agents.find((a) => a.id === id)?.name ?? id) : '主 Agent')
  const lines: string[] = [
    `# 执行记录：${tk.title}`,
    `方式：${tk.mode === 'workflow' ? `工作流「${tk.workflowName || tk.workflowId}」（id: ${tk.workflowId}）` : `对话（Agent: ${agentName(tk.agentId)}）`}　状态：${tk.status}${tk.exportedWhileRunning ? '（导出时任务还在跑，统计到导出那一刻）' : ''}　开始：${localTime(tk.createdAt)}`,
    '',
    '## 统计',
    `- 跨度 ${fmtDuration(st.spanMs)}：执行 ${fmtDuration(st.durationMs)}（等你确认/提问 ${fmtDuration(st.waitMs)} 已含在其中），${st.childBusyMs ? `子对话占用 ${fmtDuration(st.childBusyMs)}，` : ''}空闲 ${fmtDuration(st.idleMs)}${st.idleWaitMs ? `（其中等你回下一句 ${fmtDuration(Math.min(st.idleWaitMs, st.idleMs))}）` : ''}。${idleNote}`,
    `- 轮次：用户消息 ${st.asks} 条，分成 ${st.turns} 轮执行${unfinished}${st.turns ? '（对话页开着时，用户的新消息会直接交回同一个进程，多条消息可能都算在同一轮里）' : '（这条记录没有分轮信息，按用户消息的条数和过程里的时间来对）'}`,
    `- Token：输入 ${fmtK(st.inputTokens)}（缓存命中 ${fmtK(st.cacheReadTokens)}，${pct(st.cacheHitRate)}），输出 ${fmtK(st.outputTokens)}，费用 $${st.costUsd.toFixed(3)}${kids.tasks ? '（自身，不含子对话）' : ''}`,
    ...(kids.tasks
      ? [
          `- 子对话 ${kids.tasks} 个（它们各自是独立任务，上面和下面的节点表都只算自身）：执行 ${fmtDuration(kids.durationMs)}，其中等用户 ${fmtDuration(kids.waitMs)}；Token：输入 ${fmtK(kids.inputTokens)}（缓存命中 ${fmtK(kids.cacheReadTokens)}，${pct(kids.cacheHitRate)}），输出 ${fmtK(kids.outputTokens)}，费用 $${kids.costUsd.toFixed(3)}；报错 ${kids.errors} 条`,
          `- 含子对话合计（${all.tasks} 个任务）：执行 ${fmtDuration(all.durationMs)}，其中等用户 ${fmtDuration(all.waitMs)}；Token：输入 ${fmtK(all.inputTokens)}（缓存命中 ${fmtK(all.cacheReadTokens)}，${pct(all.cacheHitRate)}），输出 ${fmtK(all.outputTokens)}，费用 $${all.costUsd.toFixed(3)}；节点 ${all.steps.total} 个，返工 ${all.reworks} 次${allReworkText}，报错 ${all.errors} 条（其中失败的工具调用 ${all.failedTools} 次），追加要求/对话 ${all.turns} 轮`,
        ]
      : []),
    ...(cacheMismatch(st)
      ? [
          `- 注意：缓存命中数 ${fmtK(st.cacheReadTokens)} 超过输入合计 ${fmtK(st.inputTokens)}，这两个数不是一个口径（某个 CLI 的 input 不含缓存或没换算），命中率已封顶到 100%，实际值不可信`,
        ]
      : []),
    `- 节点 ${st.steps.total} 个：完成 ${st.steps.done}，失败 ${st.steps.failed}，跳过 ${st.steps.skipped}，未完成 ${st.steps.pending}；返工 ${st.reworks} 次${reworkText}；报错 ${st.errors} 条（其中失败的工具调用 ${st.failedTools} 次）`,
  ]
  // 用户每条要求的发出时间：判断「后面越来越慢」时看相邻两条之间隔了多久
  const asks = tk.messages.filter((m) => m.role === 'user' && !m.peer)
  if (asks.length > 1)
    lines.push(
      `- 用户发言时间：${asks
        .map((m) => {
          const d = new Date(m.at ?? '')
          return Number.isFinite(d.getTime())
            ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
            : '?'
        })
        .join('、')}`,
    )
  if (st.nodes.length) {
    lines.push(
      '',
      '改文件列只统计 CLI 亲自报告的文件改动（Write、Edit 类工具）；只读节点和用命令写文件的不计入。任务整体的改动见下面的「改动的文件」。',
      '',
      '| 节点 id | 标题 | 类型 | Agent | 状态 | 耗时 | 等待 | 验收轮数/结论 | 输入/缓存命中 | 输出 | 改文件 | 报错 |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
    )
    for (const n of st.nodes)
      lines.push(
        `| ${n.id} | ${n.title} | ${[n.kind, n.slot].filter(Boolean).join('/')} | ${agentName(n.agentId)} | ${n.status}${n.interrupted ? '（被打断）' : ''} | ${fmtDuration(n.ms)} | ${fmtDuration(n.waitMs)} | ${n.rounds}/${n.verdict || '-'} | ${fmtK(n.inputTokens)}/${pct(n.cacheHitRate)} | ${fmtK(n.outputTokens)} | ${n.files} | ${n.errors} |`,
      )
  }
  for (const w of tk.workflows) {
    lines.push('', `## 工作流定义：${w.name}（id: ${w.id}）`)
    if (w.description) lines.push(w.description)
    lines.push(
      `主 Agent：${agentName(w.mainAgentId)}（id: ${w.mainAgentId || '-'}）　主 Agent 调度：${w.dispatch === false ? '关' : '开'}`,
    )
    if (w.document.trim()) lines.push('', '### 工作流说明', clip(w.document.trim(), 6000))
    for (const f of w.flows) {
      lines.push('', `### 流程「${f.name || f.id}」（flow id: ${f.id}）`)
      lines.push(`连线：${f.edges.map((e) => `${e.from}→${e.to}${e.when ? `[${e.when}]` : ''}`).join('，') || '无'}`)
      for (const n of f.nodes) {
        const hooks = (['start', 'review', 'end'] as const)
          .filter((k) => n.hooks[k])
          .map((k) => `${k}=${n.hooks[k]!.kind}:${n.hooks[k]!.id}`)
        lines.push(
          '',
          `#### 节点「${n.title || n.id}」（node id: ${n.id}）`,
          n.steps.length
            ? `按顺序执行 ${n.steps.length} 步${hooks.length ? `　入口：${hooks.join('，')}` : ''}`
            : `类型 ${n.kind}${n.flow ? `（执行 ${n.flow.kind}:${n.flow.id}）` : ''}　Agent：${agentName(n.agentId)}　档位：${n.tier || '默认'}　重试：${n.retries}　验收最多 ${n.hooks.maxRounds} 轮${hooks.length ? `　入口：${hooks.join('，')}` : ''}${n.hooks.confirm ? '　完成后等用户确认' : ''}`,
        )
        if (n.steps.length) {
          for (const [i, s] of n.steps.entries()) {
            lines.push(
              `${i + 1}. ${s.title || s.id}：${s.kind === 'flow' ? `执行 ${s.flow?.kind}:${s.flow?.id}` : agentName(s.agentId)}　档位：${s.tier || '默认'}　重试：${s.retries}　验收最多 ${s.maxRounds} 轮${s.review ? `（${s.review.kind}:${s.review.id}）` : ''}${s.confirm ? '　完成后等用户确认' : ''}`,
            )
            if (s.instructions.trim()) lines.push('   要求：', clip(s.instructions.trim(), 3000))
          }
        } else if (n.instructions.trim()) lines.push('要求：', clip(n.instructions.trim(), 3000))
      }
    }
  }
  if (b.agents.length) {
    lines.push('', '## 用到的 Agent')
    for (const a of b.agents) {
      lines.push(
        '',
        `### ${a.name}（agent id: ${a.id}）`,
        `CLI：${a.cli || '默认'}　模型：${a.model || '默认'}　思考：${a.effort || '默认'}${a.skills.length ? `　Skill：${a.skills.join('、')}` : ''}`,
      )
      if (a.description) lines.push(a.description)
      if (a.instructions.trim()) lines.push('角色设定：', clip(a.instructions.trim(), 3000))
    }
  }
  lines.push('', '## 执行过程')
  // 每条带上时间：长任务「后面越来越慢」只能靠时间戳定位从哪一步开始变慢
  const at = (iso: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isFinite(d.getTime())
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} `
      : ''
  }
  let step = ''
  let last = ''
  for (const m of tk.messages) {
    if (m.role === 'system' && !m.error && !m.answers) continue
    if (m.step !== step) {
      step = m.step
      const s = tk.steps.find((x) => x.id === step)
      lines.push('', s ? `### 节点：${s.title}（${s.id}，${s.status}）` : '### 节点之外')
    }
    const who = m.peer
      ? `${PEER_REL[m.peer.rel] ?? '别的对话'}（${m.peer.name || m.peer.title || m.peer.id}）发来`
      : m.role === 'user'
        ? '用户'
        : m.role === 'system'
          ? m.error
            ? '报错'
            : '用户回答'
          : `AI（${agentName(m.agentId)}）`
    const body = m.answers
      ? m.answers.map((a) => `${a.question}：${a.answer}`).join('\n')
      : (m.role === 'user' ? withAttachments(m.text, m.attachments) : m.text).trim()
    const stamp = at(m.at ?? '')
    // 和上一条同一秒的合并显示，不重复刷时间；间隔超过 1 分钟单独提示，看出等待在哪
    const gap = m.at && last ? Date.parse(m.at) - Date.parse(last) : 0
    if (gap > 60_000) lines.push('', `_（距上一条 ${fmtDuration(gap)}）_`)
    if (stamp) last = m.at ?? ''
    const failed = m.tools.filter((x) => x.failed)
    const tools = m.tools.length
      ? `\n工具：${m.tools
          .slice(0, 30)
          .map((x) => `${x.name || x.kind} ${x.label}${x.failed ? '（失败）' : ''}`)
          .join('；')}${m.tools.length > 30 ? `…共 ${m.tools.length} 个` : ''}`
      : ''
    // 失败的工具调用给出完整命令、退出码和输出尾部：只看到「（失败）」判断不了原因，
    // 而 label 是截断过的一行，命令后半段（往往正是出错的那段）看不到
    const detail = failed.length
      ? `\n失败详情：${failed
          .slice(0, 5)
          .map((x) => {
            const what = (x.kind === 'run' && x.input ? x.input : x.label).trim()
            const code = x.exitCode === undefined ? '' : `（退出码 ${x.exitCode}）`
            const out = (x.output || x.detail || '').trim()
            // 有输出但退出码非零，和什么都没输出，是两种不同的排查方向，分开写
            return `\n- ${x.name || x.kind} ${what}${code}\n${out ? clip(out, 1200) : '（没有输出）'}`
          })
          .join('')}`
      : ''
    // 用户的要求不截断：约束、边界条件常常写在后面，截掉就判断不了是否满足要求
    const limit = m.role === 'user' ? Infinity : maxOutput
    if (body || tools) lines.push(`**${who}**：${stamp}${clip(body, limit)}${tools}${detail}`)
  }
  const outs = tk.steps.filter((s) => s.output.trim())
  if (outs.length) {
    lines.push('', '## 节点的最终输出（交给下游的内容）')
    // 引擎已经把输出截到 MAX_OUTPUT，更长的全文存在 handoff 文件里、去向说明写在输出末尾（见 shared/engine.ts 的 storeOutput）。
    // 这里按 maxOutput 再截一次正好切掉那句去向说明，分析时既看不到全文也不知道去哪读，所以原样输出
    for (const s of outs) lines.push('', `### ${s.title}（${s.id}）`, s.output.trim())
  }
  // 改动的文件按节点自己的记录列：任务级 changes 是「项目目录相对任务开始时」的差额，
  // 同一个工作区里并行的其他任务改了文件也会算进来，不能当成这次任务的产出
  const mine = tk.steps.filter((s) => s.changes.length)
  if (mine.length) {
    lines.push('', '## 改动的文件（按节点记录）', '（只列 CLI 报告的文件改动，不是这个节点期间工作区的全部变化）')
    for (const s of mine)
      lines.push('', `### ${s.title}（${s.id}）`, ...s.changes.map((c) => `- ${c.path} +${c.add} -${c.del}`))
  } else if (tk.changes.length) {
    lines.push(
      '',
      '## 改动的文件',
      '（任务级统计：项目目录相对任务开始时全部有变化的文件；同一工作区里别的任务改的文件也会出现在这里）',
      ...tk.changes.slice(0, 80).map((c) => `- ${c.path} +${c.add} -${c.del}`),
    )
  }
  return lines.join('\n')
}

/** 多次执行合成一份报告（分析一个工作流最近几次的执行） */
export function analysisReport(bundles: TaskExport[], max = 120_000) {
  const per = Math.floor(max / Math.max(1, bundles.length))
  return bundles
    .map((b, i) => {
      const r = taskReport(b)
      const head = bundles.length > 1 ? `<!-- 第 ${i + 1} 次执行 -->\n` : ''
      return (
        head +
        (r.length > per
          ? `${r.slice(0, per * 0.4)}\n\n…（中间省略 ${r.length - per} 字）…\n\n${r.slice(-per * 0.6)}`
          : r)
      )
    })
    .join('\n\n---\n\n')
}

/** 面板执行工作流的代码在哪：分析框架问题时引用 */
const FRAMEWORK_MAP = `- shared/engine.ts：工作流执行引擎（节点调度、并发、验收轮次、开始/验收/结束入口、条件连线、重试）
- shared/dispatch.ts：主 Agent 调度（评估子 Agent 结果、通过/退回/委派工作流、整理最终结果）
- shared/agent-role.ts：拼 Agent 的角色设定、参数模板、节点用哪一档模型
- shared/flow.ts：流程图结构、拓扑顺序、工作流快照
- server/exec/runner.ts：真实执行（启动 CLI、续接会话、交接文件、权限请求、提问）
- server/exec/*.ts：各 CLI 的输出解析和参数
- shared/task.ts：计时、等待时间、用量统计`

/** 交给 Agent 的分析要求 */
export function analysisPrompt(bundles: TaskExport[], focus = '') {
  const flows = new Map<string, Workflow>()
  for (const b of bundles) for (const w of b.task.workflows) if (!flows.has(w.id)) flows.set(w.id, w)
  const agents = new Map<string, Agent>()
  for (const b of bundles) for (const a of b.agents) agents.set(a.id, a)
  const targets = [
    ...[...flows.values()].map(
      (w) =>
        `- 工作流 workflowId: ${w.id}｜${w.name}\n${w.flows
          .flatMap((f) => f.nodes.map((n) => `  - 节点 flowId: ${f.id}, nodeId: ${n.id}｜${n.title || n.id}`))
          .join('\n')}`,
    ),
    ...[...agents.values()].filter((a) => a.id).map((a) => `- Agent agentId: ${a.id}｜${a.name}`),
  ]
  const one = bundles.length === 1 ? bundles[0].task : null
  const head = one
    ? `分析附件里这次${one.mode === 'workflow' ? '工作流执行' : '对话'}「${one.title}」的完整记录`
    : `分析附件里工作流最近 ${bundles.length} 次执行的完整记录`
  return `${head}，判断哪里需要优化，并给出可以直接应用的修改建议。只分析，不要修改任何文件。

${promptLangRules()}
${focus.trim() ? `\n用户特别关心：${focus.trim()}\n` : ''}
## 要回答的问题
1. 结果质量：最终产出是否达到了用户的要求？哪里不够好、为什么（引用记录里的原文或节点）。
2. 工作流本身：节点拆分是否合理、要求写得清不清楚、有没有多余或缺少的节点、验收标准和轮数、模型档位和重试是否合适；
   结合统计看耗时、token、缓存命中率、返工和报错集中在哪里，哪些节点可以合并、并行或用更低的档位。
3. Agent：角色设定有没有含糊、冲突、和节点要求重复的地方。
4. 面板框架：有没有看起来是面板（执行引擎、调度、CLI 调用、计时统计）本身的问题，而不是工作流写得不好，
   例如状态不对、输出丢失、重复执行、等待时间算错、提示词拼得不对。面板代码的位置：
${FRAMEWORK_MAP}
   只写成发现，写清现象、依据和可能的位置（文件路径，能确定时带行号），不要去改面板代码。
5. 交付的代码：执行改出来的项目代码里如果有能从记录确定的具体缺陷（报错、漏改、明显写错），也写成发现，同样不要去改；
   拿不准的不写。

## 回复格式
用${promptLangWord()}写，排版要好读：开头不加标题，用两三句话给结论；再用「### 1. 结果质量」「### 2. 工作流」「### 3. Agent」「### 4. 面板框架」「### 5. 交付的代码」五个小标题分节，节里用列表一条一条写，每条都要有依据，关键数字和节点名加粗。没有问题的一节写一句「没有发现问题」。

最后单独写一个代码块，语言名写 ${EVOLUTION_LANG}，内容是 JSON，把建议的修改写成可以直接应用的形式：

\`\`\`${EVOLUTION_LANG}
{
  "summary": "一句话概括这次的建议",
  "changes": [
    {"target": "node", "workflowId": "…", "flowId": "…", "nodeId": "…", "field": "instructions", "value": "改好后的完整内容", "reason": "为什么这样改"},
    {"target": "workflow", "workflowId": "…", "field": "document", "value": "改好后的完整说明", "reason": "…"},
    {"target": "agent", "agentId": "…", "field": "instructions", "value": "改好后的完整角色设定", "reason": "…"}
  ],
  "issues": [
    {"scope": "panel", "category": "执行引擎", "title": "问题标题", "detail": "现象、依据、建议怎么改", "files": ["shared/engine.ts:120"]},
    {"scope": "project", "category": "登录页", "title": "…", "detail": "…", "files": ["src/pages/Login.tsx:42"]}
  ]
}
\`\`\`

- issues 是代码问题（上面第 4、5 点的发现）：scope 为 panel 表示面板框架本身的问题，project 表示这次交付的项目代码的问题；
  category 写问题所在的模块，四个字以内（面板的问题用执行引擎、调度、角色设定、CLI 调用、统计、界面这类名字），同一模块的问题用同一个名字。
  界面按模块分组显示，每条可以单独开一个子对话去修，所以每条只写一个问题，detail 要写到修的人不看记录也能动手。
- target 为 node 时 field 可以是 instructions、title、tier（high/medium/low/空字符串）、retries（0-5）、maxRounds（1-10）、confirm（true/false）；
  workflow 可以是 document、description；agent 可以是 instructions、description。
- value 写修改后的**完整**值（不是片段，也不是差异），用户会看到和现在的对比再决定是否应用。
- 只用下面列出的 id，不要编造；没有值得改的就写空数组。不要为了凑数改动，每条改动都要能从记录里找到依据。

## 可以修改的对象
${targets.join('\n') || '（没有工作流，只能给 Agent 的建议）'}`
}

// ---- 修改建议 ----

const NODE_FIELDS = ['instructions', 'title', 'tier', 'retries', 'maxRounds', 'confirm'] as const
const Change = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('node'),
    workflowId: z.string(),
    flowId: z.string().default(''),
    nodeId: z.string(),
    field: z.enum(NODE_FIELDS),
    value: z.unknown(),
    reason: z.string().default(''),
  }),
  z.object({
    target: z.literal('workflow'),
    workflowId: z.string(),
    field: z.enum(['document', 'description']),
    value: z.unknown(),
    reason: z.string().default(''),
  }),
  z.object({
    target: z.literal('agent'),
    agentId: z.string(),
    field: z.enum(['instructions', 'description']),
    value: z.unknown(),
    reason: z.string().default(''),
  }),
])
export type EvolutionChange = z.infer<typeof Change>

/** 一条代码问题：panel 是面板框架本身的，project 是这次交付的项目代码的 */
export interface CodeIssue {
  scope: 'panel' | 'project'
  /** 问题所在的模块，界面按它分组；AI 没给时为空 */
  category: string
  title: string
  detail: string
  files: string[]
}

export interface Evolution {
  summary: string
  changes: EvolutionChange[]
  issues: CodeIssue[]
}

const BLOCK = new RegExp('```' + EVOLUTION_LANG + '[^\\n]*\\n([\\s\\S]*?)```', 'g')

/** 从回复里读出最后一个建议块；格式不对的单条跳过 */
export function parseEvolution(text: string): Evolution | null {
  const last = [...text.matchAll(BLOCK)].at(-1)
  if (!last) return null
  let raw: unknown
  try {
    raw = JSON.parse(last[1].trim())
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const changes = (Array.isArray(o.changes) ? o.changes : [])
    .map((c) => Change.safeParse(c))
    .filter((p) => p.success)
    .map((p) => p.data)
  // 旧版的建议块只有 framework（都是面板框架的问题），照样读出来
  const list = Array.isArray(o.issues) ? o.issues : Array.isArray(o.framework) ? o.framework : []
  const issues = list
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      scope: f.scope === 'project' ? ('project' as const) : ('panel' as const),
      category: String(f.category ?? '')
        .trim()
        .slice(0, 20),
      title: String(f.title ?? '').trim(),
      detail: String(f.detail ?? '').trim(),
      files: Array.isArray(f.files) ? f.files.map(String).slice(0, 10) : [],
    }))
    .filter((f) => f.title || f.detail)
  return { summary: String(o.summary ?? '').trim(), changes, issues }
}

/** 显示时去掉建议块（界面另外画成可以审阅的差异）；流式输出到一半时去掉到结尾 */
export function stripEvolution(text: string) {
  if (!text.includes('```' + EVOLUTION_LANG)) return text
  return text
    .replace(BLOCK, '')
    .replace(new RegExp('```' + EVOLUTION_LANG + '[\\s\\S]*$'), '')
    .trimEnd()
}

/** 一条建议在现在的数据上的样子：改之前、改之后（都转成文字方便对比）；对象不存在或值不合法时给出原因 */
export interface ResolvedChange {
  change: EvolutionChange
  /** 显示用：工作流「x」· 节点「y」· 要求 */
  label: string
  /** label 拆开的两段：改的是哪个对象（工作流「x」· 节点「y」）、哪一项（要求）；界面分开排版 */
  scope: string
  field: string
  before: string
  after: string
  error?: string
}

const fieldLabel = (f: string, agent = false) =>
  ({
    instructions: agent ? t('角色设定') : t('要求'),
    title: t('标题'),
    tier: t('模型档位'),
    retries: t('失败重试次数'),
    maxRounds: t('验收最多轮数'),
    confirm: t('完成后等用户确认'),
    document: t('工作流说明'),
    description: t('简介'),
  })[f] ?? f

const text = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/** 校验并规整建议的值，不合法时返回错误 */
function normalize(c: EvolutionChange): { value: unknown } | { error: string } {
  const v = c.value
  if (c.target === 'node' && c.field === 'tier')
    return ['', 'high', 'medium', 'low'].includes(String(v ?? ''))
      ? { value: String(v ?? '') }
      : { error: t('档位只能是 high、medium、low 或空') }
  if (c.target === 'node' && (c.field === 'retries' || c.field === 'maxRounds')) {
    const n = Number(v)
    const [lo, hi] = c.field === 'retries' ? [0, 5] : [1, 10]
    return Number.isInteger(n) && n >= lo && n <= hi
      ? { value: n }
      : { error: t('应该是 {lo} 到 {hi} 的整数', { lo, hi }) }
  }
  if (c.target === 'node' && c.field === 'confirm')
    return typeof v === 'boolean' ? { value: v } : { error: t('应该是 true 或 false') }
  if (typeof v !== 'string') return { error: t('应该是文字') }
  const max = c.field === 'title' ? 60 : c.field === 'description' ? 200 : c.target === 'node' ? 20000 : 50000
  if (c.field === 'title' && !v.trim()) return { error: t('标题不能为空') }
  return v.length > max
    ? { error: t('超过 {n} 字', { n: max }) }
    : { value: c.field === 'title' || c.field === 'description' ? v.trim() : v }
}

export function resolveChange(c: EvolutionChange, workflows: Workflow[], agents: Agent[]): ResolvedChange {
  const f = fieldLabel(c.field, c.target === 'agent')
  const norm = normalize(c)
  const after = 'value' in norm ? text(norm.value) : text(c.value)
  if (c.target === 'agent') {
    const a = agents.find((x) => x.id === c.agentId)
    const label = t('角色「{name}」· {field}', { name: a?.name ?? c.agentId, field: f })
    const head = { change: c, label, scope: t('角色「{name}」', { name: a?.name ?? c.agentId }), field: f }
    if (!a) return { ...head, before: '', after, error: t('本机没有这个角色') }
    return { ...head, before: text(a[c.field]), after, error: 'error' in norm ? norm.error : undefined }
  }
  const w = workflows.find((x) => x.id === c.workflowId)
  if (c.target === 'workflow') {
    const label = t('工作流「{name}」· {field}', { name: w?.name ?? c.workflowId, field: f })
    const head = { change: c, label, scope: t('工作流「{name}」', { name: w?.name ?? c.workflowId }), field: f }
    if (!w) return { ...head, before: '', after, error: t('本机没有这个工作流') }
    return { ...head, before: text(w[c.field]), after, error: 'error' in norm ? norm.error : undefined }
  }
  const flow = w?.flows.find((x) => x.id === c.flowId) ?? w?.flows.find((x) => x.nodes.some((n) => n.id === c.nodeId))
  const node = flow?.nodes.find((n) => n.id === c.nodeId)
  const label = t('工作流「{name}」· 节点「{node}」· {field}', {
    name: w?.name ?? c.workflowId,
    node: node?.title || c.nodeId,
    field: f,
  })
  const scope = t('工作流「{name}」· 节点「{node}」', { name: w?.name ?? c.workflowId, node: node?.title || c.nodeId })
  const head = { change: c, label, scope, field: f }
  if (!w) return { ...head, before: '', after, error: t('本机没有这个工作流') }
  if (!node) return { ...head, before: '', after, error: t('工作流里没有这个节点') }
  const cur = c.field === 'maxRounds' || c.field === 'confirm' ? (node.hooks[c.field] ?? false) : node[c.field]
  return { ...head, before: text(cur), after, error: 'error' in norm ? norm.error : undefined }
}

/** 把选中的建议应用到工作流和 Agent 上，返回改过的那些（调用方再保存）；不合法的跳过 */
export function applyChanges(changes: EvolutionChange[], workflows: Workflow[], agents: Agent[]) {
  const ws = new Map<string, Workflow>()
  const as = new Map<string, Agent>()
  for (const c of changes) {
    const norm = normalize(c)
    if (!('value' in norm)) continue
    if (c.target === 'agent') {
      const a = as.get(c.agentId) ?? agents.find((x) => x.id === c.agentId)
      if (a) as.set(a.id, { ...a, [c.field]: norm.value })
      continue
    }
    const base = ws.get(c.workflowId) ?? workflows.find((x) => x.id === c.workflowId)
    if (!base) continue
    const w: Workflow = structuredClone(base)
    if (c.target === 'workflow') (w as Record<string, unknown>)[c.field] = norm.value
    else {
      const flow =
        w.flows.find((x) => x.id === c.flowId && x.nodes.some((n) => n.id === c.nodeId)) ??
        w.flows.find((x) => x.nodes.some((n) => n.id === c.nodeId))
      const node = flow?.nodes.find((n) => n.id === c.nodeId)
      if (!node) continue
      if (c.field === 'maxRounds') node.hooks.maxRounds = norm.value as number
      else if (c.field === 'confirm') node.hooks.confirm = norm.value as boolean
      else (node as Record<string, unknown>)[c.field] = norm.value
    }
    ws.set(w.id, w)
  }
  return { workflows: [...ws.values()], agents: [...as.values()] }
}

/** 按行比较两段文字（最长公共子序列），给建议的差异视图用；太长时退化成整段替换 */
export function lineDiff(a: string, b: string): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const x = a ? a.split('\n') : []
  const y = b ? b.split('\n') : []
  if (x.length * y.length > 4_000_000)
    return [...x.map((s) => ({ kind: 'del' as const, text: s })), ...y.map((s) => ({ kind: 'add' as const, text: s }))]
  const n = x.length
  const m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { kind: 'same' | 'add' | 'del'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ kind: 'same', text: x[i] }), i++, j++)
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: x[i++] })
    else out.push({ kind: 'add', text: y[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] })
  while (j < m) out.push({ kind: 'add', text: y[j++] })
  return out
}

/** 在线演示：按分析要求里列出的对象编一份建议，演示里也能看到差异和应用 */
export function demoEvolution(prompt: string) {
  const node = /- 工作流 workflowId: (\S+?)｜[^\n]*\n {2}- 节点 flowId: (\S+?), nodeId: (\S+?)｜([^\n]+)/.exec(prompt)
  const changes: Record<string, unknown>[] = node
    ? [
        // 演示只改简介和档位，不动节点要求：免得应用后演示里的工作流不能用了
        {
          target: 'workflow',
          workflowId: node[1],
          field: 'description',
          value: '交给它的事先确认范围再动手：列出要用到的文件和接口，产出写清楚改了什么、怎么验证的',
          reason: '记录里节点花了较多时间摸索范围，简介里写明做法，选工作流时也更清楚',
        },
        {
          target: 'node',
          workflowId: node[1],
          flowId: node[2],
          nodeId: node[3],
          field: 'tier',
          value: 'medium',
          reason: '这一步不需要最高档，降一档能省 token',
        },
      ]
    : []
  // 角色也给一条：演示里能看到「应用到角色」
  const agent = /- Agent agentId: (\S+?)｜/.exec(prompt)
  if (agent)
    changes.push({
      target: 'agent',
      agentId: agent[1],
      field: 'description',
      value: '动手前先列出要改的文件和验证方式，做完逐条对照要求自查',
      reason: '记录里同一个范围问题问了两遍，简介写明先确认范围',
    })
  return (
    '```' +
    EVOLUTION_LANG +
    '\n' +
    JSON.stringify(
      {
        summary: '把做法写进简介，降低不必要的模型档位',
        changes,
        issues: [
          {
            scope: 'panel',
            category: '执行引擎',
            title: '验收不通过后重做时没有带上一轮的改动摘要',
            detail:
              '演示示例：重做的节点重新读了一遍全部文件，耗时比第一轮还长。可以在退回意见里附上上一轮的改动列表。',
            files: ['shared/engine.ts'],
          },
          {
            scope: 'project',
            category: '商品卡片',
            title: '价格为空时卡片报错',
            detail:
              '演示示例：商品没有价格时 product.price.toFixed 会抛错，整个列表白屏。显示前先判断，没有价格时显示「暂无报价」。',
            files: ['src/components/ProductCard.tsx:7'],
          },
        ],
      },
      null,
      2,
    ) +
    '\n```'
  )
}
