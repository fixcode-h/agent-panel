/**
 * 用户在诊断报告上点「取消修复」后，临时日志由 Agent 删、面板核对（用户 2026-11-10 定）：
 * 面板只读地查出 `[排查-` 日志在哪，交给 Agent 一处一处删（连加日志时带进来的空白行），
 * 这一轮结束后按「加日志之前的快照」核对：没有残留、没有多出的空行、没删多。核对通过才关闭报告。
 * 面板不做一键扫描删除，也不拿快照还原文件——快照只用来核对。
 * 这里只放纯函数（查日志、逐行比较、核对、给 Agent 的话），读写文件在 server/tasks/bug-cleanup.ts
 */

/** 临时日志的统一前缀（`[排查-<主题>]`），和收尾核对（server/tasks/merge.ts）同一个 */
export const TEMP_LOG = '[排查-'

/** 文件里的一行：行号从 1 起，text 是那一行原文（去掉行尾空白） */
export type FileLine = { file: string; line: number; text: string }

const linesOf = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')

/** 文件里所有含临时日志前缀的行 */
export function tempLogLines(file: string, content: string): FileLine[] {
  if (!content.includes(TEMP_LOG)) return []
  return linesOf(content)
    .map((text, i) => ({ file, line: i + 1, text: text.trimEnd() }))
    .filter((x) => x.text.includes(TEMP_LOG))
}

/** 逐行比较的一步：same 两边都有；add 只在新的里（at 是插在旧文件第几行之后，0 表示开头）；del 只在旧的里 */
export type LineOp =
  | { op: 'same'; a: number; b: number }
  | { op: 'add'; b: number; at: number; text: string }
  | { op: 'del'; a: number; text: string }

/** 中间不同的部分超过这么多格就不逐行比了（几千行都改了的文件不会是只删了几行日志） */
const MAX_CELLS = 4_000_000

/**
 * 两个版本逐行比较：先去掉相同的开头和结尾，中间按最长公共子序列对齐。
 * 改动集中在几处时中间很短；中间太大时整段算删了再加上（核对会报「改动太多」，交给用户看）
 */
export function lineDiff(before: string, after: string): LineOp[] {
  const a = linesOf(before)
  const b = linesOf(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const ops: LineOp[] = []
  for (let i = 0; i < head; i++) ops.push({ op: 'same', a: i, b: i })
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)
  if (am.length * bm.length > MAX_CELLS) {
    am.forEach((text, i) => ops.push({ op: 'del', a: head + i, text }))
    bm.forEach((text, j) => ops.push({ op: 'add', b: head + j, at: head + am.length, text }))
  } else {
    // dp[i][j]：am[i..] 和 bm[j..] 的最长公共子序列长度
    const w = bm.length + 1
    const dp = new Uint32Array((am.length + 1) * w)
    for (let i = am.length - 1; i >= 0; i--)
      for (let j = bm.length - 1; j >= 0; j--)
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        ops.push({ op: 'same', a: head + i, b: head + j })
        i++
        j++
      } else if (j < bm.length && (i >= am.length || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
        ops.push({ op: 'add', b: head + j, at: head + i, text: bm[j] })
        j++
      } else {
        ops.push({ op: 'del', a: head + i, text: am[i] })
        i++
      }
    }
  }
  for (let k = 0; k < tail; k++) ops.push({ op: 'same', a: a.length - tail + k, b: b.length - tail + k })
  return ops
}

/** 一个文件的核对结果：left 还在的临时日志、blank 多出的空行、extra 多出的别的行、removed 删多了的行 */
export type FileCheck = {
  file: string
  left: FileLine[]
  blank: FileLine[]
  extra: FileLine[]
  removed: FileLine[]
}

const blankLine = (s: string) => !s.trim()

/**
 * 核对一个文件删干净了没有。
 * - base：加日志之前的内容（快照）；没有快照（导入的对话、快照丢了）只查残留。
 * - pre：点取消那一刻的内容（日志还在、修复改动也在）。
 * - strict：还没改过逻辑（论证、根因、方案阶段取消，或者用户要求修复也撤掉）：删完要和快照一模一样。
 *   否则只看「加日志那几段」：那几段里的空行不能留，快照里有的行不能比取消前少。
 */
export function checkFile(
  file: string,
  now: string,
  opts: { base?: string; pre?: string; strict: boolean },
): FileCheck {
  const r: FileCheck = { file, left: tempLogLines(file, now), blank: [], extra: [], removed: [] }
  if (opts.base === undefined) return r
  const ops = lineDiff(opts.base, now)
  const at = (op: Extract<LineOp, { op: 'add' }>): FileLine => ({ file, line: op.b + 1, text: op.text.trimEnd() })
  if (opts.strict || opts.pre === undefined) {
    for (const op of ops) {
      if (op.op === 'add' && !op.text.includes(TEMP_LOG)) (blankLine(op.text) ? r.blank : r.extra).push(at(op))
      if (op.op === 'del') r.removed.push({ file, line: op.a + 1, text: op.text.trimEnd() })
    }
    return r
  }
  // 加日志那几段插在快照的哪几行之后：那里留下的空行算没删干净
  const logAt = new Set<number>()
  const before = lineDiff(opts.base, opts.pre)
  for (let k = 0; k < before.length; k++) {
    const op = before[k]
    if (op.op !== 'add') continue
    // 同一处连着加的几行算一段：段里有日志，整段的位置都记下
    let end = k
    while (end + 1 < before.length && before[end + 1].op === 'add') end++
    const run = before.slice(k, end + 1) as Extract<LineOp, { op: 'add' }>[]
    if (run.some((x) => x.text.includes(TEMP_LOG))) logAt.add(op.at)
    k = end
  }
  const removedBefore = new Set(before.filter((x) => x.op === 'del').map((x) => (x as { a: number }).a))
  for (const op of ops) {
    if (op.op === 'add' && blankLine(op.text) && logAt.has(op.at)) r.blank.push(at(op))
    if (op.op === 'del' && !removedBefore.has(op.a)) r.removed.push({ file, line: op.a + 1, text: op.text.trimEnd() })
  }
  return r
}

export const fileClean = (c: FileCheck) => !c.left.length && !c.blank.length && !c.extra.length && !c.removed.length

/**
 * 叫 Agent 删临时日志的话（发给 Agent 的提示词，不翻译）：列出面板查到的每一处（文件:行 + 原文），
 * 要求连空行一起删、一处一处删，不整文件还原（实跑时它用 git checkout -- 文件 还原，共用目录会冲掉别的改动）
 */
export function cleanupPrompt(o: {
  rev: number
  found: FileLine[]
  /** 用户勾了要一起删的、为排查新建的文件 */
  drop?: string[]
  /** 用户要求修复也撤掉（共用目录、已经修完时） */
  revertFix?: boolean
  /** 再删一次：上一次核对没通过的地方 */
  failed?: FileCheck[]
}): string {
  const list = o.found.map((x) => `- ${x.file}:${x.line}  ${x.text.trim()}`).join('\n')
  const drop = o.drop?.length ? `\n- 这些为排查新建的文件用户要求一起删掉：${o.drop.join('、')}` : ''
  const fix = o.revertFix ? '\n- 用户要求修复也撤掉：方案里改过的地方也改回去，删完这些文件要和加日志之前一样' : ''
  const again = o.failed?.length ? `\n\n上一次没删干净，面板核对出这些问题：\n${failedText(o.failed)}` : ''
  return `用户在第 ${o.rev} 版点了「不修了」。结束前用改文件工具删掉你加的 [排查-] 临时日志：
${list || '- （面板没查到，按你加过的位置再看一遍）'}
只删这些，不改别的代码：
- 为打日志加的临时变量、import 一起删；
- 加日志时一起加的空白行也删掉，删完文件要和加日志之前一样，不留空行；
- 不要用 git checkout / git restore / p4 revert / svn revert 整个文件还原（会把文件里别的改动一起冲掉），一处一处删。${drop}${fix}${again}
删完结束这一轮，面板会核对。不要交报告，也不要请父对话收尾。`
}

/** 核对没过的地方，一行一处（给 Agent 和对话里那一行共用） */
export function failedText(list: FileCheck[]): string {
  const rows: string[] = []
  for (const c of list) {
    for (const x of c.left) rows.push(`- ${c.file}:${x.line} 还有临时日志：${x.text.trim()}`)
    for (const x of c.blank) rows.push(`- ${c.file}:${x.line} 多了一个空行`)
    for (const x of c.extra) rows.push(`- ${c.file}:${x.line} 多了一行：${x.text.trim()}`)
    for (const x of c.removed) rows.push(`- ${c.file} 删多了快照里第 ${x.line} 行：${x.text.trim()}`)
  }
  return rows.join('\n')
}
