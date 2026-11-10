/**
 * 诊断报告里的原文（设计稿 2026-11-10「诊断报告：取消时清理临时日志，定位用日志原文和代码原文」第 3 节）：
 * Agent 只写「在哪」，原文由面板取；Agent 摘抄的原文，面板按来源逐字核对，对不上就拒收这一版。
 * - 代码（codeRefs）：交报告时读出那几行存进快照，之后回看都是当时的代码；marks.text 要在那一行里逐字出现，
 *   加了临时日志行号偏了几行的，在附近 ±5 行里找到就改过去并告诉 Agent（实跑 F5：高亮到了错的一行）；
 * - 用户贴的日志（quotes kind: log）：按「第几份报告上贴的、第几行」取原文；Agent 抄了原文的要对得上（实跑 F7）；
 * - 命令输出（kind: run）：在这个对话的工具输出里逐字（空白归一）找；
 * - 构造数据的复现只算推演，不能当排除假设的依据（实跑 F8）。
 * 这里只放纯函数；读文件、取版本管理的 diff 由宿主给（BugSource，server/exec 里接上）
 */
import type { BugCase, BugCollect, BugLogPoint, CodeRef, Diagnosis } from './bug-diagnosis-schema.ts'
import { lineDiff, TEMP_LOG } from './bug-cleanup.ts'
import { phaseOf } from './bug-phase.ts'
import type { TaskMessage } from './schema.ts'

/** 宿主给的读取能力：交报告时同步调用（工具调用本来就在等结果，读几个小文件不碍事） */
export interface BugSource {
  /** 读项目里的文件（相对对话目录，也认绝对路径）；读不到返回 undefined */
  read(file: string): string | undefined
  /** 版本管理里某次改动对这个文件的 diff（git show）；取不到返回 undefined */
  show?(rev: string, file: string): string | undefined
  /** 这个文件现在和对话开始时比的 diff（unified diff，新文件和空文件比）；取不到返回 undefined */
  diff?(file: string): string | undefined
}

/** 一段代码最多引用这么多行：出错的那几行，调用方另起一段 */
export const MAX_REF_LINES = 30
/** 一条日志引用最多这么多行 */
const MAX_QUOTE_LINES = 30
/** 标记的那一行找不到原文时，往上下各找这么多行（临时日志把行号挤偏了） */
const NEAR = 5

const linesOf = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 已证实的结论里不该出现的猜测词（设计稿 4.3）：只提醒，不拒收 */
const VAGUE = ['可能', '应该是', '估计', '大概', '似乎', '也许', '或许']

export type Resolved = { error: string; notes: string[] }

/** 只有旧写法 codeRef 时换成一段 codeRefs（有宿主能取快照时才换，没快照的照旧走工作区现读） */
function legacyRef(c: BugCase): CodeRef[] {
  const r = c.codeRef
  if (c.codeRefs.length || !r?.file) return c.codeRefs
  return [
    {
      id: 'C1',
      role: 'fault',
      file: r.file,
      start: r.start,
      end: r.end,
      marks: r.mark ? [{ line: r.mark, text: '', note: '', level: 'fault' }] : [],
      snapshot: undefined,
    },
  ]
}

/** 一段代码：核对范围、按 marks.text 校准行号、取快照。出错返回给 Agent 的话 */
function resolveRef(ref: CodeRef, src: BugSource, notes: string[], now: string): string {
  const name = ref.id || ref.file
  if (!ref.file.trim()) return `codeRefs 的 ${name} 没写 file（相对项目根的路径）。`
  const content = src.read(ref.file)
  if (content === undefined) return `codeRefs 的 ${name}：读不到 ${ref.file}，file 写相对项目根的路径。`
  const lines = linesOf(content)
  if (ref.end < ref.start) ref.end = ref.start
  if (ref.end - ref.start + 1 > MAX_REF_LINES)
    return `codeRefs 的 ${name}（${ref.file}:${ref.start}-${ref.end}）超过 ${MAX_REF_LINES} 行：只引用出错的那几行（5~15 行），调用方另起一段。`
  if (ref.start > lines.length)
    return `codeRefs 的 ${name}：${ref.file} 只有 ${lines.length} 行，第 ${ref.start} 行不存在。`
  const has = (n: number, text: string) =>
    n >= 1 && n <= lines.length && lines[n - 1].includes(text) && !lines[n - 1].includes(TEMP_LOG)
  const deltas: number[] = []
  for (const m of ref.marks) {
    const text = m.text.trim() ? m.text : ''
    if (!text) continue
    if (has(m.line, text)) {
      deltas.push(0)
      continue
    }
    let found = 0
    for (let k = 1; k <= NEAR && !found; k++)
      found = has(m.line + k, text) ? m.line + k : has(m.line - k, text) ? m.line - k : 0
    if (!found) {
      const at = lines[m.line - 1]
      return `${ref.file}:${m.line} 里没有「${text}」：marks.text 照文件原样写那一行里出错的那几个字${at === undefined ? '' : `（现在第 ${m.line} 行是：${short(at.trim())}）`}。`
    }
    notes.push(
      `${ref.file}:${m.line} 里没有「${short(text, 40)}」，第 ${found} 行有，已按第 ${found} 行标出（加了临时日志后行号会偏，按现在的文件写）。`,
    )
    deltas.push(found - m.line)
    m.line = found
  }
  // 所有带原文的标记都偏了同样几行：整段范围和不带原文的标记一起挪
  const d = deltas[0]
  if (deltas.length && d && deltas.every((x) => x === d)) {
    ref.start += d
    ref.end += d
    for (const m of ref.marks) if (!m.text.trim()) m.line += d
  }
  for (const m of ref.marks) {
    if (m.line < ref.start) ref.start = m.line
    if (m.line > ref.end) ref.end = m.line
  }
  ref.start = Math.max(1, ref.start)
  ref.end = Math.min(lines.length, ref.end)
  ref.snapshot = { text: lines.slice(ref.start - 1, ref.end).join('\n'), at: now }
  return ''
}

/** 用户在哪一份报告上贴的日志：写了 from 按它找，没写取最近贴过日志的那一份 */
function logSource(list: Diagnosis[], from: number | undefined, src?: BugSource) {
  const d = from
    ? list.find((x) => x.version === from)
    : [...list].reverse().find((x) => x.logs.trim() || x.logFiles.length)
  if (!d) return undefined
  if (d.logs.trim()) return { version: d.version, text: d.logs }
  for (const f of d.logFiles) {
    const text = src?.read(f)
    if (text !== undefined) return { version: d.version, text: text.slice(0, 5_000_000) }
  }
  return undefined
}

/** 命令输出：这个对话里所有工具输出（空白归一后逐字找） */
const outputsOf = (messages: TaskMessage[]) =>
  messages.flatMap((m) => (m.tools ?? []).map((x) => x.output ?? '').filter(Boolean)).map(norm)

function resolveQuotes(c: BugCase, list: Diagnosis[], messages: TaskMessage[], src?: BugSource): string {
  let outputs: string[] | undefined
  for (const q of c.quotes) {
    if (!q.id.trim()) return 'quotes 每一条都要写 id（Q1、Q2…），正文和证据链用编号引用。'
    if (q.kind === 'note') continue
    if (q.kind === 'run') {
      if (!q.text.trim()) return `${q.id} 是命令输出：text 原样复制实际跑出来的那几行。`
      outputs ??= outputsOf(messages)
      const want = norm(q.text)
      if (!outputs.some((o) => o.includes(want)))
        return `${q.id} 的原文在这个对话的命令输出里找不到：贴实际跑出来的那几行，不要改写；只是转述就改成 kind: note。`
    } else {
      const s = logSource(list, q.from, src)
      if (!s)
        return `${q.id}：${q.from ? `第 ${q.from} 份报告上` : '之前'}没有用户贴的日志。引用日志写 from（用户在第几份报告上贴的，报告 #n）和 start~end 行号。`
      const lines = linesOf(s.text)
      if (!q.start) {
        // 只抄了原文：按第一行在日志里找位置
        const first = norm(linesOf(q.text.trim())[0] ?? '')
        const at = first ? lines.findIndex((l) => norm(l).includes(first)) : -1
        if (at < 0)
          return `${q.id} 写的原文在第 ${s.version} 份报告的日志里找不到：写 start~end 行号，或从日志里原样复制，不要删改。`
        q.start = at + 1
        q.end = at + linesOf(q.text.trim()).length
      }
      q.end = Math.max(q.start, q.end ?? q.start)
      if (q.start > lines.length)
        return `${q.id}：第 ${s.version} 份报告的日志只有 ${lines.length} 行，第 ${q.start} 行不存在。`
      if (q.end - q.start + 1 > MAX_QUOTE_LINES) return `${q.id} 超过 ${MAX_QUOTE_LINES} 行：只引用说明问题的那几行。`
      const got = lines.slice(q.start - 1, Math.min(q.end, lines.length)).join('\n')
      if (q.text.trim() && !norm(got).includes(norm(q.text)))
        return `${q.id} 写的原文和用户贴的日志第 ${q.start}~${q.end} 行对不上：从日志里原样复制，不要删改、不要用 … 截断（那几行是：${short(norm(got), 200)}）。`
      q.text = got
      q.from = s.version
    }
    const miss = q.highlight.find((h) => h.trim() && !q.text.includes(h))
    if (miss) return `${q.id} 的原文里没有「${short(miss, 40)}」：highlight 写原文里逐字出现的关键值。`
  }
  return ''
}

/** 证据链、假设引用的编号要存在；构造数据复现时，已排除的假设要有日志或命令输出原文（F8） */
function refsProblem(c: BugCase): string {
  const ids = new Set([...c.quotes.map((q) => q.id), ...c.codeRefs.map((r) => r.id)].filter(Boolean))
  const bad = [...c.chain.flatMap((x) => x.refs), ...c.hypotheses.flatMap((h) => h.refs)].filter((r) => !ids.has(r))
  if (bad.length)
    return `这些引用编号在 quotes、codeRefs 里没有：${[...new Set(bad)].join('、')}。先在 quotes / codeRefs 里写上，再用编号引用。`
  const hard = new Set(c.quotes.filter((q) => q.kind === 'log' || q.kind === 'run').map((q) => q.id))
  if (c.reproKind === 'constructed') {
    const weak = c.hypotheses.filter((h) => h.status === 'excluded' && !h.refs.some((r) => hard.has(r)))
    if (weak.length)
      return `复现用的是构造的数据（reproKind: constructed），只能说明「这样也能算出来」，不能排除别的假设：${weak.map((h) => h.id || h.text.slice(0, 20)).join('、')} 的依据要引用用户日志或命令输出原文（refs），没有就标 open，下一轮加日志确认。`
  }
  return ''
}

/** 提醒（不拒收，写进回执）：已证实的结论用了猜测的词、出错点没有代码和日志原文 */
function reminders(c: BugCase, phase: string): string[] {
  const out: string[] = []
  if (c.confirmed && (phase === 'cause' || phase === 'plan')) {
    const text = [c.rootCause, ...c.chain.map((x) => x.text)].join('\n')
    const words = VAGUE.filter((w) => text.includes(w))
    if (words.length)
      out.push(
        `根因和证据链里有「${words.join('、')}」：已证实的结论不用猜测的词；没证实的写成「假设：……，用 X 确认」。`,
      )
  }
  if (phase === 'cause') {
    const fault = c.chain.find((x) => x.step === 'fault')
    const kinds = new Map<string, string>([
      ...c.quotes.map((q) => [q.id, q.kind] as [string, string]),
      ...c.codeRefs.map((r) => [r.id, 'code'] as [string, string]),
    ])
    const has = (k: string) => !!fault?.refs.some((r) => kinds.get(r) === k)
    if (fault && (!has('code') || !(has('log') || has('run'))))
      out.push(
        '证据链的出错点最好引用一段代码（codeRefs）和一条证明走了这个分支的日志或命令输出原文（quotes），refs 写编号。',
      )
  }
  return out
}

/** 引入那次改动的 diff：只留碰到出错点那几行原文的段落，取不到就空 */
function attributionDiff(c: BugCase, src: BugSource): string {
  const a = c.attribution
  const fault = c.codeRefs.find((r) => r.role === 'fault') ?? c.codeRefs[0]
  if (!a?.change.trim() || !fault || !src.show || !/^[\w./~^@-]{4,80}$/.test(a.change.trim())) return ''
  const raw = src.show(a.change.trim(), fault.file)
  if (!raw?.trim()) return ''
  const hunks = raw.split(/\n(?=@@ )/).filter((h) => h.startsWith('@@ '))
  const keys = fault.marks.map((m) => m.text.trim()).filter(Boolean)
  const snap = (fault.snapshot?.text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 3)
  const hit = hunks.filter((h) => keys.some((k) => h.includes(k)) || snap.some((l) => h.includes(l)))
  return (hit.length ? hit : hunks.slice(0, 2)).join('\n').slice(0, 8000)
}

/** 最近一份根因 / 方案里取过快照的代码：修完以后那几行变了，验证这一版沿用它，不重新取 */
const causeRefs = (list: Diagnosis[]) =>
  [...list]
    .reverse()
    .find((d) => (phaseOf(d) === 'cause' || phaseOf(d) === 'plan') && d.codeRefs.some((r) => r.snapshot))

/**
 * 验证这一版：根因那一版每段代码的快照和现在的代码对照（设计稿 4.4「验证页实际改动」）。
 * 现在的位置按快照的头尾两行在原位置附近找；临时日志两边都不算
 */
export function fixDiffs(list: Diagnosis[], src: BugSource): Diagnosis['fixDiffs'] {
  const cause = causeRefs(list)
  if (!cause) return []
  const out: Diagnosis['fixDiffs'] = []
  for (const r of cause.codeRefs) {
    if (!r.snapshot || r.role === 'expected') continue
    const content = src.read(r.file)
    if (content === undefined) continue
    const now = linesOf(content)
    const was = r.snapshot.text.split('\n')
    const find = (text: string, from: number) => {
      for (let k = 0; k < 200; k++)
        for (const n of [from + k, from - k]) if (n >= 0 && n < now.length && now[n] === text) return n
      return -1
    }
    const a = find(was[0], r.start - 1)
    const b = a < 0 ? -1 : find(was[was.length - 1], a + was.length - 1)
    const window = a >= 0 && b >= a ? now.slice(a, b + 1) : now.slice(r.start - 1, r.start - 1 + was.length + 10)
    const keep = (ls: string[]) => ls.filter((l) => !l.includes(TEMP_LOG)).join('\n')
    const ops = lineDiff(keep(was), keep(window))
    if (!ops.some((o) => o.op !== 'same')) continue
    const left = keep(was).split('\n')
    const diff = ops
      .map((o) => (o.op === 'same' ? ` ${left[o.a]}` : o.op === 'del' ? `-${o.text}` : `+${o.text}`))
      .join('\n')
    out.push({ id: r.id, file: r.file, diff: diff.slice(0, 8000) })
  }
  return out
}

/**
 * 交报告时取原文、核对（submitDiagnosis 调）：改的是草稿 c（快照、校准后的行号、日志原文）。
 * 没有宿主（单测、导入的对话）时只核对编号，不取快照
 */
export function resolveSources(
  c: BugCase,
  ctx: { list: Diagnosis[]; messages: TaskMessage[]; phase: string; src?: BugSource; now: string },
): Resolved {
  const notes: string[] = []
  const src = ctx.src
  if (ctx.phase === 'fix' || ctx.phase === 'verify') {
    // 已经修完：出错点那几行变了，代码沿用根因那一版的快照（marks.text 在现在的文件里多半找不到了）
    const cause = causeRefs(ctx.list)
    c.codeRefs = cause ? structuredClone(cause.codeRefs) : c.codeRefs.map((r) => ({ ...r, snapshot: undefined }))
  } else if (src) {
    c.codeRefs = legacyRef(c)
    for (const r of c.codeRefs) {
      const bad = resolveRef(r, src, notes, ctx.now)
      if (bad) return { error: bad, notes }
    }
  } else for (const r of c.codeRefs) r.snapshot = undefined
  const q = resolveQuotes(c, ctx.list, ctx.messages, src)
  if (q) return { error: q, notes }
  const refs = refsProblem(c)
  if (refs) return { error: refs, notes }
  if (c.attribution) c.attribution.diff = (src && attributionDiff(c, src)) || undefined
  notes.push(...reminders(c, ctx.phase))
  return { error: '', notes }
}

/** 日志计划的一处在用户贴的日志里出现了几次、第一次在哪一行（设计稿 3.2 的命中表） */
export type LogHit = { point: BugLogPoint; count: number; first?: { line: number; text: string } }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 按 `[排查-主题] L<n>` 的编号数：日志行里有前缀、前缀后面有这个编号（L1 不会算进 L12） */
export function logHits(logs: string, plan: BugLogPoint[]): LogHit[] {
  const lines = linesOf(logs)
  return plan
    .filter((p) => p.id.trim())
    .map((point) => {
      const re = new RegExp(`(^|[^A-Za-z0-9])${esc(point.id.trim())}(?![0-9A-Za-z])`)
      let count = 0
      let first: LogHit['first']
      lines.forEach((l, i) => {
        const at = l.indexOf(TEMP_LOG)
        if (at < 0 || !re.test(l.slice(at))) return
        count++
        first ??= { line: i + 1, text: l.trimEnd() }
      })
      return { point, count, first }
    })
}

/** 结果怎么判里写了可核对条件（match）的几项，这次日志对上了哪几项；没写条件的不判 */
export function outcomeMatches(c: BugCollect | undefined, hits: LogHit[]): (boolean | undefined)[] {
  return (c?.outcomes ?? []).map((o) => {
    if (!o.match?.point.trim()) return undefined
    const h = hits.find((x) => x.point.id.trim().toUpperCase() === o.match!.point.trim().toUpperCase())
    return h ? h.count > 0 === o.match.seen : undefined
  })
}
