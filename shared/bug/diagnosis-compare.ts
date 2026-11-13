/**
 * 诊断报告和上一份对比（用户 2026-11-13 定，设计稿「诊断报告-提问补充出新版」2.4）：
 * 用户提问、补充后它重出一版，用户要看出改了哪几节、结论变没变。这里只放纯函数：
 * 报告 Markdown 按小节切开逐节比，结论变没变按档案字段比（不看 Agent 写的话）。
 * 页面（web/src/components/ui/report-compare.tsx）和演示版都用这一份
 */
import type { Diagnosis } from './diagnosis-schema.ts'
import { lineDiff } from './cleanup.ts'
import { normPath, phaseOf } from './phase.ts'

/** 对比里的一行：add 新的一份多出的、del 上一份有这一份没了的、ctx 两份都有的 */
export interface CompareLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

/**
 * 一节的对比：same 没改、changed 改了、added 这一份新加的、removed 这一份没了。
 * lines 是逐行的差异（没改的节为空），add / del 是增删的行数
 */
export interface CompareSection {
  title: string
  state: 'same' | 'changed' | 'added' | 'removed'
  lines: CompareLine[]
  add: number
  del: number
}

/** 小节标题：报告里要审的用 ##、收起的背景里用 ###（shared/bug/md.ts 的 sec），都切开 */
const HEAD = /^#{2,3}\s+(.+?)\s*$/

/** 按 ## / ### 标题切成小节；代码块里的 # 不算标题。标题前的文字算一节「（开头）」 */
export function splitSections(md: string): { title: string; body: string }[] {
  const out: { title: string; body: string[] }[] = []
  let fence = false
  let cur: { title: string; body: string[] } | undefined
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = fence ? null : HEAD.exec(line)
    if (h) {
      cur = { title: h[1], body: [] }
      out.push(cur)
      continue
    }
    if (!cur) {
      if (!line.trim()) continue
      cur = { title: '', body: [] }
      out.push(cur)
    }
    cur.body.push(line)
  }
  // 同名小节（两个「### 第 1 条」）按出现顺序编号，免得对错节
  const seen = new Map<string, number>()
  return out.map((s) => {
    const n = (seen.get(s.title) ?? 0) + 1
    seen.set(s.title, n)
    return { title: n > 1 ? `${s.title} (${n})` : s.title, body: s.body.join('\n').trim() }
  })
}

/** 两段正文逐行比：去掉首尾空行，空白行不算改动 */
function diffBody(a: string, b: string): { lines: CompareLine[]; add: number; del: number } {
  const ops = lineDiff(a, b)
  const bl = b.replace(/\r\n?/g, '\n').split('\n')
  const lines: CompareLine[] = []
  // 一段连着的改动里先列删掉的、再列加上的（和常见 diff 一样读成「把这几行换成那几行」）
  let dels: CompareLine[] = []
  let adds: CompareLine[] = []
  const flush = () => {
    lines.push(...dels, ...adds)
    dels = []
    adds = []
  }
  for (const o of ops) {
    if (o.op === 'same') {
      flush()
      lines.push({ kind: 'ctx', text: bl[o.b] ?? '' })
    } else (o.op === 'del' ? dels : adds).push({ kind: o.op, text: o.text })
  }
  flush()
  const real = (k: CompareLine['kind']) => lines.filter((l) => l.kind === k && l.text.trim()).length
  return { lines, add: real('add'), del: real('del') }
}

/**
 * 两份报告逐节对比：按新的一份的小节顺序列，上一份有、这一份没了的接在后面。
 * skip 是不比的小节标题（「回答你的意见」每份都不同，对比上面另有一行写回答了几条）
 */
export function compareReports(prevMd: string, curMd: string, skip: string[] = []): CompareSection[] {
  const prev = splitSections(prevMd).filter((s) => !skip.includes(s.title))
  const cur = splitSections(curMd).filter((s) => !skip.includes(s.title))
  const old = new Map(prev.map((s) => [s.title, s.body]))
  const out: CompareSection[] = cur.map((s) => {
    const before = old.get(s.title)
    if (before === undefined) {
      const lines = s.body.split('\n').map((text): CompareLine => ({ kind: 'add', text }))
      return { title: s.title, state: 'added', lines, add: lines.filter((l) => l.text.trim()).length, del: 0 }
    }
    if (before === s.body) return { title: s.title, state: 'same', lines: [], add: 0, del: 0 }
    const d = diffBody(before, s.body)
    // 只差空白行：算没改
    return d.add || d.del
      ? { title: s.title, state: 'changed', ...d }
      : { title: s.title, state: 'same', lines: [], add: 0, del: 0 }
  })
  const now = new Set(cur.map((s) => s.title))
  for (const s of prev) {
    if (now.has(s.title)) continue
    const lines = s.body.split('\n').map((text): CompareLine => ({ kind: 'del', text }))
    out.push({ title: s.title, state: 'removed', lines, add: 0, del: lines.filter((l) => l.text.trim()).length })
  }
  return out
}

const same = (a: string | undefined, b: string | undefined) => (a ?? '').trim() === (b ?? '').trim()
const fileSet = (files: string[]) => [...new Set(files.map(normPath).filter(Boolean))].sort().join('\n')

/**
 * 结论变没变（报告上「结论没变 / 结论已改」的胶囊）：只按档案字段比，不看 Agent 写的话——
 * 阶段、根因、是否证实、不用改代码的判断、选定的方案、要改的文件，任一项不同就算改了
 */
export function conclusionChanged(prev: Diagnosis, d: Diagnosis): boolean {
  if (phaseOf(prev) !== phaseOf(d)) return true
  if (!same(prev.rootCause, d.rootCause) || prev.confirmed !== d.confirmed) return true
  if ((prev.noFix?.kind ?? '') !== (d.noFix?.kind ?? '')) return true
  if (!same(prev.chosen?.id, d.chosen?.id)) return true
  return fileSet(prev.files) !== fileSet(d.files)
}
