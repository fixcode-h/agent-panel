import type { DataUsage, MemorySample, MemoryUsage } from './data.ts'
import { fmtDuration } from './duration.ts'

/**
 * 内存采样怎么显示、怎么交给 AI 分析。
 * 界面（设置 →「数据」的内存曲线）和「AI 分析」的提示词共用这里的格式化，序列也是同一份，
 * 免得界面上看到的趋势和交给 AI 的判断对不上。
 */

/** 「AI 分析」用的 topic：服务端据此补运行环境（见 server/memory.ts） */
export const MEMORY_TOPIC = 'memory'

/** 字节数转成「1.2 MB」这种：数据占用、内存曲线、交给 AI 的报告都用它 */
export function formatBytes(n: number) {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 进程运行了多久：和别处一样用统一的耗时写法（1d 3h / 2h 5m / 4m 3.6s / 41.2s） */
export const formatUptime = fmtDuration

/** 采样时刻按本地时间显示：曲线的时间轴、最近一次采样时间用；跨天的带上月-日 */
export function formatSampleTime(at: string, now = new Date()) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

export interface MemoryTrend {
  /** 涨、跌还是基本平：看面板进程的 RSS */
  trend: 'up' | 'down' | 'flat'
  /** 这段序列里 RSS 的变化（字节），正数是涨 */
  delta: number
  /** 堆的变化（字节） */
  heapDelta: number
  /** 序列覆盖的时长（毫秒） */
  spanMs: number
  /** 平均每分钟涨多少字节 */
  perMinute: number
  /** 最高的一次采样（涨到多少能对上） */
  peak: MemorySample
}

/**
 * 序列是涨还是平：只看最近一段（默认最近 30 分钟、至少 5 分钟）。
 * 太短的窗口里进程刚开始跑，启动期的增长会被当成泄漏；变化不到 5% 且不到 2 MB 算平稳，免得抖动吓人。
 */
export function memoryTrend(
  samples: MemorySample[],
  opts: { windowMs?: number; minSpanMs?: number } = {},
): MemoryTrend | null {
  if (samples.length < 2) return null
  const windowMs = opts.windowMs ?? 30 * 60_000
  const minSpanMs = opts.minSpanMs ?? 5 * 60_000
  const last = samples[samples.length - 1]
  const end = Date.parse(last.at)
  const from = end - windowMs
  // 窗口里至少要有两个点才谈得上趋势
  const inWindow = samples.filter((s) => Date.parse(s.at) >= from)
  const seq = inWindow.length >= 2 ? inWindow : samples.slice(-2)
  const first = seq[0]
  const spanMs = end - Date.parse(first.at)
  const delta = last.rss - first.rss
  const threshold = Math.max(2 * 1024 * 1024, first.rss * 0.05)
  const trend = spanMs < minSpanMs ? 'flat' : delta > threshold ? 'up' : delta < -threshold ? 'down' : 'flat'
  return {
    trend,
    delta,
    heapDelta: last.heapUsed - first.heapUsed,
    spanMs,
    perMinute: spanMs > 0 ? (delta / spanMs) * 60_000 : 0,
    peak: samples.reduce((a, b) => (b.rss > a.rss ? b : a), samples[0]),
  }
}

const trendText = (tr: MemoryTrend) => {
  const span = formatUptime(tr.spanMs)
  if (tr.trend === 'up') return `${span}内涨了 ${formatBytes(tr.delta)}（每分钟约 ${formatBytes(tr.perMinute)}）`
  if (tr.trend === 'down') return `${span}内降了 ${formatBytes(-tr.delta)}`
  return `${span}内基本平稳（变化 ${formatBytes(tr.delta)}）`
}

/** 曲线显示的时间窗口：右端停在 endMs（默认最新），左端往前 windowMs；窗口外相邻的点也带上，曲线能画到边上 */
export function chartWindow(samples: MemorySample[], endMs: number, windowMs: number) {
  const from = endMs - windowMs
  const inWindow = samples.filter((s) => {
    const t = Date.parse(s.at)
    return t >= from && t <= endMs
  })
  const before = samples.filter((s) => Date.parse(s.at) < from).slice(-1)
  return { from, to: endMs, points: [...before, ...inWindow] }
}

/**
 * 右键左右拖动曲线：把时间窗口平移去看更早的采样。
 * dxPx 是鼠标横向移动的像素（往右为正 = 想看更早），窗口宽度对应 windowMs，所以右端往回挪同样的比例；
 * 限制在「最早采样 + 一个窗口」到「最新采样」之间：再往右拖就是最新的数据，等于回到跟随最新。
 */
export function panEndMs(o: {
  endMs: number
  dxPx: number
  widthPx: number
  windowMs: number
  earliestMs: number
  latestMs: number
}) {
  if (o.widthPx <= 0) return o.endMs
  const shift = (o.dxPx / o.widthPx) * o.windowMs
  const minEnd = Math.min(o.latestMs, o.earliestMs + o.windowMs)
  return Math.min(o.latestMs, Math.max(minEnd, o.endMs - shift))
}

/**
 * 把采集到的内存数据整理成一段文字交给 AI：两路内存、趋势、面板规模、数据目录占用都在里面。
 * 提示词固定用中文（和 shared/fix.ts 一致），不走界面词典。
 */
export function memoryReport(u: MemoryUsage & Partial<Pick<DataUsage, 'dir' | 'kinds' | 'logs'>>) {
  const m = u.memory
  const lines: string[] = [
    `面板服务进程（本机 Node）现在的内存：RSS ${formatBytes(m.rss)}，堆 ${formatBytes(m.heapUsed)} / ${formatBytes(m.heapTotal)}，external ${formatBytes(m.external)}（其中 ArrayBuffer ${formatBytes(m.arrayBuffers)}）。`,
    m.child === null
      ? `子进程（面板拉起的 CLI 等）：${u.child.processes} 个，内存这台机器上读不到（未采集，不是 0，也不是没占用）。`
      : `子进程（面板拉起的 CLI 等）：${u.child.processes} 个，合计 ${formatBytes(m.child)}；两路合计 ${formatBytes(m.rss + m.child)}。`,
    `面板进程已运行 ${formatUptime(u.uptimeMs)}。`,
    `采样：每 ${Math.round(u.sampling.intervalMs / 1000)} 秒一次，保留最近 ${formatUptime(u.sampling.keepMs)}，现在有 ${u.samples.length} 个点${u.samples.length ? `，最早 ${formatSampleTime(u.samples[0].at)}、最近 ${formatSampleTime(m.at)}` : ''}。`,
  ]
  const tr = memoryTrend(u.samples)
  if (tr) {
    lines.push(
      `面板 RSS 趋势：${trendText(tr)}；堆 ${tr.heapDelta >= 0 ? '涨' : '降'}了 ${formatBytes(Math.abs(tr.heapDelta))}；最高 ${formatBytes(tr.peak.rss)}（${formatSampleTime(tr.peak.at)}，当时 ${tr.peak.running} 个任务在执行）。`,
    )
    // 子进程那一堆涨得比面板还多时，问题多半在 CLI 侧（比如长对话、MCP 服务），要单独说
    const kids = u.samples.filter((s) => s.child !== null)
    if (kids.length >= 2) {
      const a = kids[0]
      const b = kids[kids.length - 1]
      const span = formatUptime(Math.max(0, Date.parse(b.at) - Date.parse(a.at)))
      lines.push(`子进程内存趋势：从 ${formatBytes(a.child!)} 到 ${formatBytes(b.child!)}（${span}内）。`)
    } else if (!kids.length) {
      lines.push('子进程内存：这段序列里一次都没读到（未采集）。')
    }
  } else {
    lines.push('RSS 趋势：刚开始采样，还没有足够的数据判断。')
  }
  lines.push(
    `面板规模：任务 ${u.scale.tasks} 个（其中对话 ${u.scale.chats} 个）、项目 ${u.scale.projects} 个，正在执行 ${u.scale.running} 个。`,
  )
  if (u.kinds?.length) {
    const total = u.kinds.reduce((n, k) => n + k.bytes, 0)
    lines.push(`数据目录（${u.dir ?? '未知'}）：共 ${formatBytes(total)}`)
    for (const k of u.kinds) lines.push(`- ${k.id}：${k.files} 个文件，${formatBytes(k.bytes)}`)
    if (u.logs) lines.push(`- 运行日志：${u.logs.files} 个文件，${formatBytes(u.logs.bytes)}`)
  }
  return lines.join('\n')
}

/** 「AI 分析」的第一句话要说的事：不是报错，是主动体检，先出方案 */
export const MEMORY_ASK =
  '看一下面板进程的内存现在有没有问题（泄漏、堆积、占用过大），有问题给出能落地的优化方案；同时列出内存相关模块还能优化、扩展的地方，按优先级排序。'

/**
 * 交给 AI 的面板背景和回答要求（固定文本）。
 * 服务端在 topic 里补运行环境（Node 版本、堆上限）；在线演示没有 topic，自己补一句。
 */
export function memoryBrief() {
  return [
    '这次是主动的内存体检，不是报错排查：面板本身没有出错，用户想知道内存占用有没有问题、怎么优化。',
    '面板是怎么跑的：一个本机 Node 服务进程（server/，Hono，只监听 127.0.0.1）调度本机的编码 CLI（Claude Code、Codex 等）。每个任务由面板启动一个 CLI 子进程，面板自己的内存不包括这些子进程，所以下面分成「面板」和「子进程」两路看。',
    '内存主要在哪些地方（排查时按这些线索去看代码，别只看数字）：',
    '- server/store.ts：每个集合（任务、项目、角色、工作流……）读一次就整份留在内存里，数据目录里的 JSON 越大，常驻的越多。',
    '- server/tasks.ts：正在跑的任务、子对话、排队消息各自记在表里；任务越多、越久，这些表越大。',
    '- 对话和日志：每个任务的聊天记录在数据目录 chats/<任务 id>/ 下，读进来、转成 Markdown、发给页面时会产生临时对象和 Buffer（external / arrayBuffers）。',
    '- 运行日志、SSE 长连接、设计 / 文档 / 模型补全这些长驻对象。',
    '- 子进程那一路涨得多，重点看 CLI 侧：任务跑得久、上下文长、Claude Code / Codex 自带的 MCP 服务各占了什么。',
    '请按这个顺序回答：',
    '1. 内存是否正常：对照 V8 堆上限、面板规模（任务 / 对话数量）和运行时长，给出「正常 / 偏高 / 异常」的结论和依据。',
    '2. 有没有可疑问题：从采样序列看趋势（持续上涨 / 平稳 / 回落 / 锯齿），持续上涨的指出涨在哪段时间、可能是什么在堆；再看上面几处线索里有没有堆积点。',
    '3. 优化方案：每条写清楚改哪个文件、怎么改、预期能省多少、有什么风险；能直接动手的写成可以直接照做的步骤。',
    '4. 内存相关模块还能优化、扩展的地方：按 P0 / P1 / P2 排优先级列出清单，每条一句话说收益和改动范围。',
    '先只做分析和方案，不要直接改代码，等用户看完同意再动手。',
  ].join('\n')
}
