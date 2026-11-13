/**
 * 调用栈树的核对（设计稿 2026-11-13「诊断报告：关键调用栈」第 4.3 节）：交报告时面板做，不信 Agent 写的。
 * - 结构：编号唯一、parent 存在、出错点至多一个、最多 40 跳 8 层；根因、方案这一版必须有入口和出错点；
 * - 编号：每跳挂的 L / H / C / Q、方案的 hops、假设和日志点的 hop 都要对得上；
 * - 位置：读工作区，那一行附近找得到函数名（偏了几行的校准过去），出错点存前后几行快照；
 * - 报错堆栈：stackFrom.kind = trace 时按常见格式把原文解析成帧，树上每一跳要对上一帧。
 * 只放纯函数；读文件由宿主给（BugSource）
 */
import type { BugCase, BugHop } from './diagnosis-schema.ts'
import type { BugSource } from './quotes.ts'
import { hopTree } from './call-tree.ts'

export const MAX_HOPS = 40
const MAX_DEPTH = 8
/** 行号偏了几行（临时日志挤的、Agent 记错）时往上下找这么多行 */
const NEAR = 3
/** 出错点快照带前后几行 */
const AROUND = 1

const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id.trim()).filter(Boolean))

/** 结构和编号：对不上就拒收这一版（Agent 照着改了再交） */
export function stackProblem(c: BugCase, phase: string): string {
  const hops = c.stack
  if (hops.length > MAX_HOPS)
    return `stack 有 ${hops.length} 跳，最多 ${MAX_HOPS} 跳：和问题无关的旁支删掉，只留入口到出错点、出错点到现象这几条路。`
  const withId = hops.filter((h) => h.id.trim())
  if (withId.length && withId.length < hops.length) return 'stack 每一跳都要写 id（S1、S2…），parent 按 id 连成树。'
  const seen = new Set<string>()
  for (const h of withId) {
    if (seen.has(h.id)) return `stack 里 ${h.id} 重复了：每一跳一个编号。`
    seen.add(h.id)
  }
  const bad = withId.filter((h) => h.parent.trim() && !seen.has(h.parent))
  if (bad.length) return `这几跳的 parent 在 stack 里没有：${bad.map((h) => `${h.id} → ${h.parent}`).join('、')}。`
  const roots = hopTree(hops).roots
  if (withId.length && roots.length > 1)
    return `stack 只能有一个入口（parent 为空的只能一跳），现在有 ${roots.map((h) => h.id).join('、')}：别的跳写上 parent。`
  if (depthOf(hops) > MAX_DEPTH) return `stack 超过 ${MAX_DEPTH} 层：中间只是转一手的跳合并掉，库内部的帧不写。`
  const faults = hops.filter((h) => h.role === 'fault')
  if (faults.length > 1)
    return `出错点（role: fault）只能有一个，现在有 ${faults.length} 个：其余的写成 path 或 missed。`
  if (phase === 'cause' || phase === 'plan') {
    if (hops.length < 2 || !faults.length)
      return '根因这一版要写调用栈树（stack）：入口（entry）到出错点（fault）每一跳一项，出错点之后该执行却没执行的写 missed，现象出现的地方写 symptom；出错点写 cond（条件和走了哪边）和 values（实际值、期望值）。只写 location 一句话不算。'
  }
  return refProblem(c, seen)
}

/** 每跳挂的编号、方案 / 假设 / 日志点指向的跳，都要在档案里有 */
function refProblem(c: BugCase, hopIds: Set<string>): string {
  const known = new Set([...ids(c.quotes), ...ids(c.codeRefs), ...ids(c.logPlan), ...ids(c.hypotheses)])
  const badRefs = c.stack.flatMap((h) => h.refs.filter((r) => r.trim() && !known.has(r.trim())))
  if (badRefs.length)
    return `stack 里挂的这些编号在 quotes、codeRefs、logPlan、hypotheses 里没有：${[...new Set(badRefs)].join('、')}。`
  const pointing = [
    ...c.options.flatMap((o) => o.hops),
    ...c.hypotheses.map((h) => h.hop),
    ...c.logPlan.map((l) => l.hop),
  ].filter((x) => x.trim())
  const badHops = pointing.filter((x) => !hopIds.has(x.trim()))
  if (badHops.length)
    return `options.hops、hypotheses.hop、logPlan.hop 里这些编号在 stack 里没有：${[...new Set(badHops)].join('、')}。`
  const f = c.stackFrom
  if (f?.kind === 'trace' && !c.quotes.some((q) => q.id === f.trace.trim()))
    return 'stackFrom.kind 是 trace：先把报错堆栈作为原文写进 quotes（kind: log 或 run），stackFrom.trace 写它的编号。'
  return ''
}

function depthOf(hops: BugHop[]): number {
  const { roots, kids } = hopTree(hops)
  const walk = (h: BugHop, d: number): number => Math.max(d, ...(kids.get(h) ?? []).map((k) => walk(k, d + 1)))
  return Math.max(0, ...roots.map((r) => walk(r, 1)))
}

/**
 * 函数名里拿来在代码里找的那个词：`a.b.fn(x)` 取 fn；`Class.method`、`ns::fn` 取最后一段；
 * 出错点写的是一句代码（if (left === 0) return）时取里面最长的标识符
 */
export function fnWord(fn: string): string {
  const s = fn.trim()
  if (/^[\w$.:<>~-]+$/.test(s))
    return (
      s
        .split(/\.|::|->|:/)
        .filter(Boolean)
        .pop()
        ?.replace(/[<>~]/g, '') ?? ''
    )
  const call = /([A-Za-z_$][\w$]*)\s*\(/.exec(s)
  if (call && !KEYWORD.test(call[1])) return call[1]
  const words = (s.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).filter((w) => !KEYWORD.test(w))
  return words.length ? words.reduce((a, b) => (b.length > a.length ? b : a)) : ''
}
const KEYWORD = /^(if|else|for|while|switch|return|catch|function|const|let|var|await|async|new|throw|typeof)$/

const linesOf = (s: string) => s.replace(/\r\n?/g, '\n').split('\n')

/**
 * 位置核对（有宿主时）：读文件，line 附近找函数名；偏了几行的改过去，写进 notes 告诉 Agent。
 * 出错点存前后几行快照。超过一半的跳对不上就拒收（多半是读错了文件或凭印象写的）
 */
export function checkStack(c: BugCase, src: BugSource | undefined, notes: string[], phase: string): string {
  // 已经修完：出错点那几行变了，沿用根因那一版核对的结果和快照（和关键代码的快照一个道理）
  if (phase === 'fix' || phase === 'verify') return ''
  for (const h of c.stack) h.check = undefined
  if (!src) return ''
  const placed = c.stack.filter((h) => h.file.trim() && h.line)
  const misses: string[] = []
  for (const h of placed) {
    const text = src.read(h.file.trim())
    if (text === undefined) {
      h.check = { ok: false, why: '文件不存在', code: '' }
      misses.push(`${h.id || h.fn} ${h.file}（文件不存在）`)
      continue
    }
    const lines = linesOf(text)
    const word = fnWord(h.fn)
    // 出错点常写的是那一句代码：整句能在附近找到就按整句，不然按函数名里的词找
    const found =
      nearestText(lines, h.line!, h.fn) ||
      (word ? nearest(lines, h.line!, word) : h.line! <= lines.length ? h.line! : 0)
    if (!found) {
      h.check = { ok: false, why: `第 ${h.line} 行附近没有 ${word || h.fn}`, code: '' }
      misses.push(`${h.id || h.fn} ${h.file}:${h.line}（附近没有 ${word || h.fn}）`)
      continue
    }
    if (found !== h.line) {
      notes.push(`${h.id || h.fn} 的行号从 ${h.line} 校准到 ${found}（${word} 在第 ${found} 行）。`)
      h.line = found
    }
    h.check = { ok: true, why: '', code: '' }
    if (h.role === 'fault') {
      const start = Math.max(1, found - AROUND)
      h.check.start = start
      h.check.code = lines
        .slice(start - 1, found + AROUND)
        .join('\n')
        .slice(0, 2000)
    }
  }
  if (placed.length >= 2 && misses.length * 2 > placed.length)
    return `调用栈有一半以上的跳在代码里对不上：${misses.join('；')}。先打开文件确认路径和行号再交。`
  if (misses.length) notes.push(`调用栈这几跳在代码里没对上，报告上会标出来：${misses.join('；')}。`)
  return ''
}

const squash = (s: string) => s.replace(/\s+/g, '')

/** 整句（去掉空白）在附近哪一行；太短或只是一个标识符的不按整句找 */
function nearestText(lines: string[], line: number, fn: string): number {
  const want = squash(fn)
  if (want.length < 6 || /^[\w$.:]+$/.test(want)) return 0
  for (let d = 0; d <= NEAR; d++)
    for (const n of d ? [line - d, line + d] : [line])
      if (n >= 1 && n <= lines.length && squash(lines[n - 1]).includes(want)) return n
  return 0
}

function nearest(lines: string[], line: number, word: string): number {
  const re = new RegExp(`(^|[^\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`)
  for (let d = 0; d <= NEAR; d++)
    for (const n of d ? [line - d, line + d] : [line])
      if (n >= 1 && n <= lines.length && re.test(lines[n - 1])) return n
  return 0
}

/** 报错堆栈里的一帧 */
export type TraceFrame = { file: string; line: number; fn: string }

/**
 * 常见格式的报错堆栈 → 帧：JS/TS（at fn (file:line:col)）、Python（File "x", line N, in fn）、
 * Java / C#（at a.B.fn(File.java:12)）、Lua traceback（file.lua:12: in function 'fn'）、C++ / UE（file.cpp(123) 或 [file.cpp:123]）
 */
export function traceFrames(text: string): TraceFrame[] {
  const out: TraceFrame[] = []
  for (const l of linesOf(text)) {
    const py = /File "([^"]+)", line (\d+)(?:, in (\S+))?/.exec(l)
    if (py) {
      out.push({ file: py[1], line: Number(py[2]), fn: py[3] ?? '' })
      continue
    }
    const loc = /([\w$@~./\\-]+\.[A-Za-z0-9]{1,8})(?::(\d+)|\((\d+)\))/.exec(l)
    if (!loc) continue
    const fn =
      /\bat\s+(?:async\s+)?([\w$.<>[\]]+)\s*\(/.exec(l)?.[1] ??
      /in (?:function|method) '?<?([\w.:]+)/.exec(l)?.[1] ??
      /([\w$:~]+)\s*\(\)?\s*[[(]?[\w./\\-]*$/.exec(l.slice(0, loc.index))?.[1] ??
      ''
    out.push({ file: loc[1], line: Number(loc[2] ?? loc[3]), fn })
  }
  return out
}

const base = (f: string) => f.replace(/\\/g, '/').split('/').pop()!.toLowerCase()

/** 树上的跳对上报错堆栈的帧（文件名相同、行号差 2 行以内）：标 frame；一半以上对不上拒收 */
export function matchTrace(c: BugCase, phase: string): string {
  const f = c.stackFrom
  if (f?.kind !== 'trace' || phase === 'fix' || phase === 'verify') return ''
  const q = c.quotes.find((x) => x.id === f.trace.trim())
  const frames = q ? traceFrames(q.text) : []
  if (!frames.length)
    return `${f.trace} 里认不出报错堆栈的帧（文件:行号）：确认引用的是堆栈原文，或者把 stackFrom.kind 写成 read。`
  const placed = c.stack.filter((h) => h.file.trim() && h.line && h.role !== 'missed' && h.role !== 'side')
  const off: string[] = []
  for (const h of placed) {
    const hit = frames.some((fr) => base(fr.file) === base(h.file) && Math.abs(fr.line - h.line!) <= 2)
    h.check = {
      ok: h.check?.ok ?? true,
      why: h.check?.why ?? '',
      start: h.check?.start,
      code: h.check?.code ?? '',
      frame: hit,
    }
    if (!hit) off.push(`${h.id || h.fn} ${base(h.file)}:${h.line}`)
  }
  if (placed.length >= 2 && off.length * 2 > placed.length)
    return `stackFrom 是报错堆栈 ${f.trace}，但树上一半以上的跳不在堆栈里：${off.join('、')}。树上每一跳要是堆栈里的一帧（没走到的写 missed）。`
  return ''
}
