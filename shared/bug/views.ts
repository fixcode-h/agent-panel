/**
 * 诊断报告的「功能结构」（设计稿 2026-11-18「Bug 模式子对话体验」第 2 节）：调用栈 / 时序图 / 类图 / 架构页四个页签。
 * - 交报告时核对结构（viewsProblem）：图的开头对得上种类、节点名在图里、默认页签有内容、不是调用栈要写理由；
 * - 核对位置（checkViews）：节点写了 file:line 的按工作区找函数名（和调用栈同一套 stack-check.ts），偏了几行的校准，
 *   对不上的报告上标「位置没对上代码」，一半以上对不上拒收；
 * - 拼成 `structure` 代码块（structureMd）：界面按 web/src/lib/markdown/structure.ts 画成页签。
 * 只放纯函数；读文件由宿主给（BugSource）
 */
import type { BugCase, Diagnosis } from './diagnosis-schema.ts'
import type { BugSource } from './quotes.ts'
import type { BugViews, ViewDiagram } from './views-schema.ts'
import { linesOf, locateLine } from './stack-check.ts'

const HEAD: Record<ViewDiagram['kind'], RegExp> = {
  sequence: /^sequenceDiagram\b/,
  class: /^classDiagram\b/,
}
const KIND_NAME: Record<ViewDiagram['kind'], string> = { sequence: '时序图', class: '类图' }

/** 源码第一行有效内容（跳过空行、%% 注释和 --- 开头的配置块） */
function firstLine(source: string): string {
  const lines = linesOf(source)
  let i = 0
  if (lines[0]?.trim() === '---') {
    i = lines.findIndex((l, n) => n > 0 && l.trim() === '---') + 1
    if (i <= 0) return ''
  }
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l && !l.startsWith('%%')) return l
  }
  return ''
}

/** 节点名在图的源码里出现（参与者、类名、别名），按整词找 */
const inSource = (source: string, id: string) => {
  const w = id.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w$])${w}(?![\\w$])`).test(source)
}

/** 结构：对不上就拒收这一版（Agent 照着改了再交）；没写 views 的不查 */
export function viewsProblem(c: Pick<BugCase, 'views' | 'stack'>): string {
  const v = c.views
  if (!v) return ''
  const kinds = v.diagrams.map((d) => d.kind)
  if (new Set(kinds).size < kinds.length) return 'views.diagrams 每种图只写一张（sequence 时序图、class 类图各一张）。'
  for (const d of v.diagrams) {
    const name = KIND_NAME[d.kind]
    if (!d.source.trim()) return `views.diagrams 里的${name}没写 source（Mermaid 源码）。`
    if (!HEAD[d.kind].test(firstLine(d.source)))
      return `views.diagrams 里 kind 是 ${d.kind} 的${name}，source 要以 ${d.kind === 'sequence' ? 'sequenceDiagram' : 'classDiagram'} 开头。`
    const missing = d.nodes.filter((n) => !n.id.trim() || !inSource(d.source, n.id))
    if (missing.length)
      return `${name}的 nodes 里这些名字在图的源码里没有：${missing.map((n) => n.id || '（空）').join('、')}。id 写图里的参与者或类名。`
  }
  if (v.page && !/\.html?$/i.test(v.page.file.trim()))
    return 'views.page.file 写 Archify 画好的 .html 文件路径（相对项目根）。'
  const has: Record<BugViews['pick'], boolean> = {
    stack: c.stack.length > 0,
    sequence: kinds.includes('sequence'),
    class: kinds.includes('class'),
    page: !!v.page?.file.trim(),
  }
  if (!has[v.pick]) return `views.pick 是 ${v.pick}，但这一页没有内容：先画好它，或者 pick 改成有内容的那一页。`
  if (v.pick !== 'stack' && !v.why.trim())
    return 'views.pick 不是调用栈时，views.why 用一句话写为什么默认看它（例如「4 个参与者、中间隔着事件派发」）。'
  return ''
}

/**
 * 位置核对（有宿主时）：节点 file:line 附近找 fn（没写按 id 找），偏了几行的改过去写进 notes；
 * 超过一半的节点对不上就拒收（多半是凭印象写的）。架构页的文件要读得到
 */
export function checkViews(c: BugCase, src: BugSource | undefined, notes: string[], phase: string): string {
  const v = c.views
  // 已经修完：节点那几行可能变了，沿用根因、方案那一版的核对结果（和调用栈一样）
  if (!v || phase === 'fix' || phase === 'verify') return ''
  const nodes = v.diagrams.flatMap((d) => d.nodes)
  for (const n of nodes) n.check = undefined
  if (!src) return ''
  if (v.page?.file.trim() && src.read(v.page.file.trim()) === undefined)
    return `架构页 ${v.page.file} 读不到：先用 Archify 画好这个文件再交，或者去掉 views.page。`
  const placed = nodes.filter((n) => n.file.trim() && n.line)
  const misses: string[] = []
  for (const n of placed) {
    const text = src.read(n.file.trim())
    if (text === undefined) {
      n.check = { ok: false, why: '文件不存在' }
      misses.push(`${n.id} ${n.file}（文件不存在）`)
      continue
    }
    const want = n.fn.trim() || n.id
    const found = locateLine(linesOf(text), n.line!, want)
    if (!found) {
      n.check = { ok: false, why: `第 ${n.line} 行附近没有 ${want}` }
      misses.push(`${n.id} ${n.file}:${n.line}（附近没有 ${want}）`)
      continue
    }
    if (found !== n.line) {
      notes.push(`功能结构图的 ${n.id} 行号从 ${n.line} 校准到 ${found}。`)
      n.line = found
    }
    n.check = { ok: true, why: '' }
  }
  if (placed.length >= 2 && misses.length * 2 > placed.length)
    return `功能结构图有一半以上的节点在代码里对不上：${misses.join('；')}。先打开文件确认路径和行号再交。`
  if (misses.length) notes.push(`功能结构图这几个节点在代码里没对上，报告上会标出来：${misses.join('；')}。`)
  return ''
}

/** `structure` 代码块里的内容（界面 web/src/lib/markdown/structure.ts 读它） */
export interface StructurePayload {
  pick: BugViews['pick']
  why: string
  /** 调用栈页：calltree 代码块的正文 */
  stack: string
  diagrams: {
    kind: ViewDiagram['kind']
    title: string
    source: string
    nodes: { id: string; file: string; line?: number; ok?: boolean; why?: string }[]
  }[]
  page?: { file: string; title: string }
}

/** 没写 views 时照旧只有调用栈（旧报告、只交了调用栈的） */
export const hasViews = (d: Pick<Diagnosis, 'views'>) =>
  !!d.views && (d.views.diagrams.length > 0 || !!d.views.page?.file.trim() || d.views.pick !== 'stack')

/** 调用栈 calltree 代码块（带围栏）+ views → `structure` 代码块；没写 views 时原样返回调用栈 */
export function structureMd(d: Pick<Diagnosis, 'views'>, stackMd: string): string {
  const v = d.views
  if (!v || !hasViews(d)) return stackMd
  const stack = /^(`{3,}|~{3,})calltree\n([\s\S]*)\n\1$/.exec(stackMd)?.[2] ?? ''
  const payload: StructurePayload = {
    pick: v.pick,
    why: v.why.trim(),
    stack,
    diagrams: v.diagrams.map((x) => ({
      kind: x.kind,
      title: x.title.trim(),
      source: x.source,
      nodes: x.nodes.map((n) => ({
        id: n.id.trim(),
        file: n.file.trim(),
        ...(n.line && { line: n.line }),
        ...(n.check && { ok: n.check.ok, why: n.check.why }),
      })),
    })),
    ...(v.page?.file.trim() && { page: { file: v.page.file.trim(), title: v.page.title.trim() } }),
  }
  const json = JSON.stringify(payload, null, 1)
  const fence = json.includes('```') ? '~~~~' : '```'
  return `${fence}structure\n${json}\n${fence}`
}
