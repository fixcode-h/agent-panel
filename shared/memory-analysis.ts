import type { MemoryPoint, TaskProcess } from './schema.ts'
import { t } from './i18n.ts'
import { formatBytes, formatUptime } from './memory.ts'
import { fmtDuration } from './duration.ts'
import { clip as clipText } from './text.ts'
import { hhmm } from './datetime.ts'

/**
 * 会话内存的 AI 分析与进程归属：会话内存曲线（`web/src/components/tasks/MemoryChart.tsx`）和
 * 进程面板（`ProcessPanel.tsx`）共用这里的口径 —— 界面上看到的趋势、交 AI 的报告、进程行的归属
 * 都从同一份采样和同一份进程表算出来，免得图和结论对不上。
 *
 * 和「设置 → 数据」那套面板内存体检（`shared/memory.ts`）的区别：
 * 那边看的是面板 server 进程自己（所有对话共用），这边看的是**一个会话**：
 * 这个对话及它的附属任务起的 CLI 进程；面板自己的内存只单独展示，不计入会话合计。
 * 所以 topic、报告正文和归属规则都单独一份，不复用 MEMORY_TOPIC（否则 AI 会把两套数据混着讲）。
 */

/** 「AI 分析」用的 topic：服务端据此补运行环境（见 server/task-memory.ts） */
export const TASK_MEMORY_TOPIC = 'task-memory'

/** 判断「涨」的最小门槛：变化不到 5% 且不到 2 MB 算平稳，免得采样抖动被说成泄漏 */
const MIN_DELTA = 2 * 1024 * 1024

export type MemoryTrendKind = 'up' | 'down' | 'flat'

export interface TaskMemoryTrend {
  trend: MemoryTrendKind
  /** 窗口内合计内存（这个对话及附属的 CLI）的变化，正数是涨 */
  delta: number
  /** 窗口内 CLI 进程那一路的变化；两端有一头没采集到就是 0（不猜） */
  cliDelta: number
  /** 窗口内面板那一路的变化（面板内存不计入合计，只单独看） */
  serverDelta: number
  /** 序列覆盖的时长（毫秒） */
  spanMs: number
  /** 每分钟平均变化多少字节 */
  perMinute: number
  /** 参与判断的点数（合计读到值的点） */
  samples: number
  /** 窗口里最高的一次采样 */
  peak: { t: number; total: number }
  windowMs: number
}

/**
 * 这个会话的内存是涨还是平：只看最近一段（默认 30 分钟、至少 5 分钟），
 * 用「合计」（这个对话及附属的 CLI 进程）判断，面板那一路单独给出，方便看出问题在哪边。
 * 合计读不到的点（cli 未采集）跳过，不按 0 算。
 */
export function taskMemoryTrend(
  points: MemoryPoint[],
  opts: { windowMs?: number; minSpanMs?: number } = {},
): TaskMemoryTrend | null {
  const windowMs = opts.windowMs ?? 30 * 60_000
  const minSpanMs = opts.minSpanMs ?? 5 * 60_000
  const known = points.filter((p) => p.total !== null && p.total !== undefined)
  if (known.length < 2) return null
  const end = known[known.length - 1].t
  const inWindow = known.filter((p) => p.t >= end - windowMs)
  const seq = inWindow.length >= 2 ? inWindow : known.slice(-2)
  const first = seq[0]
  const last = seq[seq.length - 1]
  const spanMs = last.t - first.t
  const delta = (last.total ?? 0) - (first.total ?? 0)
  const threshold = Math.max(MIN_DELTA, (first.total ?? 0) * 0.05)
  const trend: MemoryTrendKind =
    spanMs < minSpanMs ? 'flat' : delta > threshold ? 'up' : delta < -threshold ? 'down' : 'flat'
  const both = (a: number | null, b: number | null) => (a === null || b === null ? 0 : b - a)
  const peakPoint = seq.reduce((a, b) => ((b.total ?? 0) > (a.total ?? 0) ? b : a), first)
  return {
    trend,
    delta,
    cliDelta: both(first.cli, last.cli),
    serverDelta: last.server - first.server,
    spanMs,
    perMinute: spanMs > 0 ? (delta / spanMs) * 60_000 : 0,
    samples: seq.length,
    peak: { t: peakPoint.t, total: peakPoint.total ?? 0 },
    windowMs,
  }
}

/** 界面上的一句话趋势（报告里另有一份固定中文的，见 taskMemoryReport） */
export function taskTrendText(tr: TaskMemoryTrend | null): string {
  if (!tr) return t('采样还太少，看不出趋势')
  const span = formatUptime(tr.spanMs)
  if (tr.trend === 'up')
    return t('最近 {span} 持续上涨（涨了 {size}，每分钟约 {rate}）', {
      span,
      size: formatBytes(tr.delta),
      rate: formatBytes(Math.max(0, tr.perMinute)),
    })
  if (tr.trend === 'down') return t('最近 {span} 在回落（降了 {size}）', { span, size: formatBytes(-tr.delta) })
  return t('最近 {span} 基本平稳（变化 {size}）', { span, size: formatBytes(tr.delta) })
}

/** 报告里的时间跨度：和界面同一套耗时写法 */
const spanText = fmtDuration

/** 一个归属分组的进程树合计：子对话只算它自己起的那些进程，不摊派、不拿别人的凑数 */
export interface OwnerGroup {
  /** 归属的对话 / 子任务 id；空字符串表示面板自己的动作，没有对话 */
  taskId: string
  title: string
  /** 是不是当前打开的这个对话 */
  self: boolean
  /** 这个归属的进程树内存合计；一个 RSS 都读不到时为 null（未采集），不是 0 */
  rss: number | null
  /** 进程数 */
  count: number
  /** 其中读到 RSS 的进程数 */
  counted: number
  processes: TaskProcess[]
}

/**
 * 按归属（server 给的 ownerTaskId）分组：面板返回的每一行都已经标了是哪个对话登记的，
 * 这里只做汇总，**不**把对不上归属的进程平摊给各个对话，也不把整棵树的 CLI 合计塞进某一行。
 * 顺序：本对话在最前，其余按占用从大到小；读不到内存的排最后。
 */
export function ownersOf(processes: TaskProcess[], selfId: string): OwnerGroup[] {
  const map = new Map<string, OwnerGroup>()
  for (const p of processes) {
    const id = p.ownerTaskId ?? ''
    let g = map.get(id)
    if (!g) {
      g = {
        taskId: id,
        // 没有归属标题时用 id 兜底；连 id 都没有（面板自己的动作）就空着，界面自己写说明
        title: p.ownerTitle || id,
        self: !!id && id === selfId,
        rss: null,
        count: 0,
        counted: 0,
        processes: [],
      }
      map.set(id, g)
    }
    g.processes.push(p)
    g.count++
    if (p.rss !== null && p.rss !== undefined) {
      g.counted++
      g.rss = (g.rss ?? 0) + p.rss
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1
    // 读不到内存的（null）排在有数字的后面，不按 0 参与比较
    const ar = a.rss ?? -1
    const br = b.rss ?? -1
    if (ar !== br) return br - ar
    return a.title.localeCompare(b.title)
  })
}

/** 一个分组的内存显示：读不到时说「未采集」，不写成 0 */
export function ownerMemoryText(g: OwnerGroup) {
  return g.rss === null ? t('未采集') : formatBytes(g.rss)
}

/** 每个对话的上下文占用（交给 AI 判断「是不是上下文太长把内存撑起来了」） */
export interface TaskContext {
  id: string
  title: string
  /** 当前上下文的 token 数 */
  context: number
  /** 模型的上下文窗口 */
  window: number
  self: boolean
}

/** 这个会话树（本对话 + 子对话）的规模：交给 AI 判断「内存高是不是因为子对话太多」 */
export interface TaskTreeScale {
  /** 整棵树的任务数（含本对话） */
  tasks: number
  /** 子对话数（含多层） */
  children: number
  /** 正在执行的任务数 */
  running: number
}

export interface TaskMemoryReportInput {
  task: { title: string; mode: string; status: string }
  project: { name: string; path: string } | null
  points: MemoryPoint[]
  intervalMs: number
  /** 进程面板的两路占用：这个对话及附属的 CLI 进程，和面板 server 自己（不计入会话合计） */
  panel: { cliMemory: number | null; serverMemory: number; unavailable: string }
  owners: OwnerGroup[]
  tree: TaskTreeScale
  contexts: TaskContext[]
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function sampleTime(t: number) {
  const d = new Date(t)
  const hm = hhmm(d)
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

/**
 * 把会话的采样序列、进程归属、任务树规模整理成一段中文交给 AI。
 * 只写事实（每一条都能在界面上看到），判断和方案交给 AI，界面不偷偷下结论。
 */
export function taskMemoryReport(u: TaskMemoryReportInput) {
  const first = u.points.find((p) => p.total !== null)
  const last = [...u.points].reverse().find((p) => p.total !== null)
  const lines: string[] = [
    '会话内存分析（Agent 面板）：用户想看这个会话的内存有没有问题、怎么优化，不是报错排查。',
    `对话：「${u.task.title}」（${u.task.mode}，当前状态 ${u.task.status}）`,
  ]
  if (u.project) lines.push(`项目：${u.project.name}（${u.project.path}）`)
  lines.push(
    `采样：每 ${Math.round(u.intervalMs / 1000)} 秒一次，这次取到 ${u.points.length} 个点${
      first && last ? `，覆盖 ${sampleTime(first.t)} – ${sampleTime(last.t)}` : ''
    }。`,
  )
  if (last) {
    const cliNote =
      u.panel.cliMemory === null ? (u.panel.unavailable ? `（${u.panel.unavailable}）` : '（进程内存未采集）') : ''
    lines.push(
      `最近一点（${sampleTime(last.t)}）：会话合计 ${formatBytes(last.total ?? 0)}${cliNote}；面板进程 ${formatBytes(last.server)}（不计入会话合计）。`,
    )
  } else {
    lines.push('现在还没有读到内存采样：先让面板跑一会儿（30 秒一点）再分析。')
  }
  const tr = taskMemoryTrend(u.points)
  if (tr) {
    const what =
      tr.trend === 'up'
        ? `持续上涨，涨了 ${formatBytes(tr.delta)}（每分钟约 ${formatBytes(Math.max(0, tr.perMinute))}）`
        : tr.trend === 'down'
          ? `在回落，降了 ${formatBytes(-tr.delta)}`
          : `基本平稳（变化 ${formatBytes(tr.delta)}）`
    lines.push(
      `趋势（最近 ${spanText(tr.spanMs)}、${tr.samples} 个点）：${what}；面板 ${signed(tr.serverDelta)}（不计入会话合计）。最高一次 ${formatBytes(tr.peak.total)}（${sampleTime(tr.peak.t)}）。`,
    )
  } else {
    lines.push('趋势：采样点太少，还判断不出是涨还是平。')
  }
  lines.push('进程归属（每行只算该对话自己起的进程树，对不上归属的不摊派）：')
  if (u.owners.length) {
    // 报告是给 AI 看的摘要：子对话很多时只列占用最大的前几个，剩下的汇总成一行，
    // 完整列表在进程面板里（那里逐行都能看到），不在这里长出一屏
    const shown = u.owners.slice(0, 15)
    for (const g of shown) {
      const who = g.self
        ? `本对话「${g.title || g.taskId}」`
        : g.taskId
          ? `「${g.title || g.taskId}」`
          : '面板自己的动作（AI 创建、文档等，没有归属对话）'
      lines.push(
        `- ${who}：${g.rss === null ? `未采集（${g.count} 个进程都没读到内存，不是 0）` : `${formatBytes(g.rss)}（${g.counted}/${g.count} 个进程读到内存）`}`,
      )
    }
    if (u.owners.length > shown.length) {
      const rest = u.owners.slice(shown.length)
      const sum = rest.reduce((n, g) => n + (g.rss ?? 0), 0)
      const unknown = rest.filter((g) => g.rss === null).length
      lines.push(
        `- 另外 ${rest.length} 个归属：读到内存的合计 ${formatBytes(sum)}${unknown ? `，其中 ${unknown} 个未采集` : ''}`,
      )
    }
  } else {
    lines.push('- 这个会话现在没有在跑的进程。')
  }
  lines.push(
    `任务树：本对话 + ${u.tree.children} 个子对话，共 ${u.tree.tasks} 个任务，其中 ${u.tree.running} 个正在执行。`,
  )
  if (u.contexts.length) {
    const self = u.contexts.find((c) => c.self)
    const kids = u.contexts.filter((c) => !c.self).sort((a, b) => b.context - a.context)
    const parts: string[] = []
    if (self && self.context > 0) parts.push(`本对话 ${tokens(self.context)} / ${tokens(self.window)} tokens`)
    if (kids.length) {
      const sum = kids.reduce((n, c) => n + c.context, 0)
      const top = kids[0]
      parts.push(
        `子对话合计 ${tokens(sum)} tokens（最大的是「${top.title}」 ${tokens(top.context)} / ${tokens(top.window)}）`,
      )
    }
    if (parts.length) lines.push(`上下文占用：${parts.join('；')}。`)
  }
  if (u.panel.unavailable) lines.push(`系统进程信息取不到的原因：${u.panel.unavailable}`)
  lines.push(
    '回答要求：先判断这个会话的内存是否正常（给出结论和依据），再按上面的趋势判断有没有泄漏或堆积迹象（采样间隔 30 秒，短时间抖动不算），然后给能落到文件和做法的优化方案，最后按 P0 / P1 / P2 排一份可优化清单。先只分析和给方案，不要直接改代码。',
  )
  return lines.join('\n')
}

const signed = (n: number) => `${n >= 0 ? '+' : '-'}${formatBytes(Math.abs(n))}`

/** 交给 AI 的背景和回答要求（固定中文）；服务端会再补这台机器的运行环境 */
export function taskMemoryBrief() {
  return [
    '这次是主动的会话内存体检，不是报错排查：面板本身没有出错，用户想知道这个会话的内存占用有没有问题、怎么优化。',
    '面板是怎么跑的：一个本机 Node 服务进程（server/，Hono，只监听 127.0.0.1）调度本机的编码 CLI（Claude Code、Codex、Pi 等）。每个对话由面板启动一个 CLI 子进程，CLI 还会起 MCP 服务等子进程。面板自己的内存不属于任何一个对话，只单独给出、不计入会话合计；会话合计只算这个对话及它的附属任务（子对话、子任务）起的 CLI 进程树。',
    '上面的数字从哪来（需要时可以按这些路径去看代码和日志）：',
    '- server/tasks.ts 的 processPanel：按「当前任务 + 它的全部后代」（shared/run-usage.ts 的 subtreeTaskIds）汇总这个对话及附属任务的进程，每个进程带 ownerTaskId / ownerTitle（归属哪个对话）。',
    '- server/exec/proc-stats.ts：系统进程表快照、进程树、按任务汇总（aggregateByTask）、30 秒一次的内存历史（summarize 接受一组任务 id，只加这些任务的 CLI）。',
    '- web/src/components/tasks/MemoryChart.tsx（会话内存曲线）、ProcessPanel.tsx（进程面板）：界面上的趋势和归属口径。',
    '- 子对话是独立的 Task（shared/schema.ts），各自起 CLI 进程；子对话多、上下文长时，CLI 那一路的内存会明显上涨。',
    '对话的上下文占用记在 Task.usage.agents 里（context / window），上下文越长，CLI 进程的常驻内存通常越高。',
    '请按这个顺序回答：',
    '1. 内存是否正常：结合两路占用、会话规模和运行时长给出「正常 / 偏高 / 异常」的结论和依据。',
    '2. 有没有泄漏或堆积的迹象：按上面的趋势判断（持续上涨 / 平稳 / 回落 / 锯齿），持续上涨要指出涨在哪一路、哪段时间、可能是什么在堆；采样间隔 30 秒，短时间的抖动不要当成泄漏。',
    '3. 具体优化方案：每条写清楚改哪个文件、怎么改、预期能省多少、有什么风险；能直接动手的写成可以照做的步骤。',
    '4. 按优先级排序的可优化清单：P0 / P1 / P2，每条一句话说收益和改动范围；除了修问题，也列出这个会话内存相关还能优化、扩展的地方。',
    '先只做分析和方案，不要直接改代码，等用户看完同意再动手。',
  ].join('\n')
}

/** 「AI 分析」的第一句话：主动体检，先出结论和方案 */
export const TASK_MEMORY_ASK =
  '看一下这个会话的内存现在有没有问题（泄漏、堆积、占用过大），按趋势判断，有问题给出能落到文件和做法的优化方案，并列出这个会话内存相关还能优化的地方（按优先级排序）。'

/** 报告进 FixInput.context（上限 8000 字）：超了截断并说明，不整段丢掉 */
export function clipReport(text: string, max = 7600) {
  return clipText(text, max, { mark: () => '\n…（报告太长，后面省略）' })
}
