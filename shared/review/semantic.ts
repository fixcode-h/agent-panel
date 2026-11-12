/**
 * 评审的「二进制文件语义差异」（UE 2）：git diff 对 .xlsx、.uasset 只有一行「二进制文件不同」，
 * 用户定的「不管改多少都要代码审查」对这类改动等于没审。这里把两版内容换成评审读得懂的文字：
 * 插件认领的扩展名按插件转出的文本逐行比，或用插件自己写的差异（表格插件按格子比）。
 * 这份文字是发给评审 Agent 的提示词，不翻译。取内容（git、p4、插件）在 server/exec/review-semantic.ts
 */
import { diffSheet, foldSame } from '../sheet-diff.ts'

/** 一个文件的语义差异最多这么多字：再长截掉，评审按文件列表自己去看 */
export const SEMANTIC_FILE_MAX = 12_000
/** 全部文件合起来的上限 */
export const SEMANTIC_MAX = 40_000

/**
 * 两段文本逐行的差异（插件转出来的文本用）：借格子差异的 LCS（shared/sheet-diff.ts），每行当一格，
 * 写成 unified diff 的样子（「-」旧、「+」新、空格是前后没改的行，「@@ … @@」是省掉的没改的行数）
 */
export function lineDiffText(a: string, b: string, context = 3) {
  const split = (s: string) => (s ? s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [])
  const la = split(a)
  const lb = split(b)
  const d = diffSheet({ rows: la.map((l) => [l]), from: 0 }, { rows: lb.map((l) => [l]), from: 0 })
  if (!d.stats.mod && !d.stats.add && !d.stats.del) return ''
  const out: string[] = []
  for (const x of foldSame(d.rows, context)) {
    if ('fold' in x) {
      out.push(`@@ 省掉 ${x.count} 行没改的 @@`)
      continue
    }
    const r = x.row
    if (r.kind === 'same') out.push(` ${lb[r.b!]}`)
    if (r.kind === 'mod' || r.kind === 'del') out.push(`-${la[r.a!]}`)
    if (r.kind === 'mod' || r.kind === 'add') out.push(`+${lb[r.b!]}`)
  }
  return out.join('\n')
}

/** 一个文件的语义差异：how 说明是怎么比的（表格按格子、哪个插件转的文本），text 为空表示两版读出来一样 */
export interface SemanticPart {
  path: string
  how: string
  text: string
  /** 读不出来、插件出错：如实写给评审 */
  error?: string
}

/** 拼成评审提示词里的一节；没有一个认得的二进制文件时返回空串 */
export function semanticSection(parts: SemanticPart[]) {
  if (!parts.length) return ''
  let room = SEMANTIC_MAX
  const blocks: string[] = []
  for (const p of parts) {
    const body = p.error
      ? `读不出语义差异：${p.error}`
      : p.text
        ? p.text.length > SEMANTIC_FILE_MAX
          ? `${p.text.slice(0, SEMANTIC_FILE_MAX)}\n…（太长，后面的没放进来）`
          : p.text
        : '两版读出来的内容一样（只是文件字节不同，比如重新保存过）。'
    const block = `### ${p.path}（${p.how}）\n\`\`\`\n${body}\n\`\`\``
    if (block.length > room) {
      blocks.push(`（还有 ${parts.length - blocks.length} 个文件的语义差异放不下，按上面的文件列表自己看）`)
      break
    }
    room -= block.length
    blocks.push(block)
  }
  return `## 二进制文件的语义差异\n上面 diff 里只显示「二进制文件不同」的文件，面板按内容整理成了下面的文字（表格按格子比、其他按认领它的插件转出的文本比），按它们评审这些文件的改动。\n\n${blocks.join('\n\n')}`
}
