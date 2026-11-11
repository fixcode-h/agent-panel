/**
 * 表格页发给 Agent 的几种请求（提示词不翻译）：照着描述加行、解释一列 / 一张表、修检查出的问题。
 * 改动一律让 Agent 用 table.propose 交给用户确认，不直接写文件
 */
import type { Problem } from './table-struct.ts'

const where = (path: string, sheet: string) => `表格 \`${path}\`（工作表「${sheet}」）`

const PROPOSE =
  '先用 table.query 看字段、主键和已有的行（必要时 table.sample 看表头、table.query 查被引用的表），照着已有数据的写法来。' +
  '改动用 table.propose 提交（不要用 table.edit，也不要自己写脚本改文件），它会按表格结构检查，不通过就改对再提交；' +
  '通过后告诉用户去表格页看「AI 提的改动」，确认后才会放进表格。note 里写清楚改了什么、依据是什么。'

export function addRowsPrompt(path: string, sheet: string, count: number, desc: string) {
  return [
    `在${where(path, sheet)}末尾加 ${count} 行。`,
    `要求：${desc.trim()}`,
    '主键接着已有的最大值往下编，枚举只用表里已经有的值，引用别的表时确认被引用的行存在。',
    PROPOSE,
  ].join('\n\n')
}

/** 改选中的一片：行号、字段写清楚，AI 只动这些格子 */
export function editRegionPrompt(path: string, sheet: string, rows: number[], fields: string[], desc: string) {
  const r0 = Math.min(...rows) + 1
  const r1 = Math.max(...rows) + 1
  const span = rows.length === r1 - r0 + 1 ? `第 ${r0}–${r1} 行` : `第 ${rows.map((r) => r + 1).join('、')} 行`
  return [
    `改${where(path, sheet)}里选中的一片：${span}，列 ${fields.join('、')}。`,
    `要求：${desc.trim()}`,
    '只改这些格子，别的行和列不要动；枚举只用已有的值，引用别的表时确认被引用的行存在；改不了的在 note 和回复里说明。',
    PROPOSE,
  ].join('\n\n')
}

export function explainColumnPrompt(path: string, sheet: string, field: string) {
  return [
    `解释${where(path, sheet)}里的「${field}」这一列：`,
    '它是做什么用的、取值范围和规律（看实际数据统计）、是枚举还是引用别的表、和哪些列有关联、填的时候要注意什么。',
    '用 table.query 读数据，需要时看被引用的表和枚举表。只读，不要改任何文件。回答简洁，用中文。',
  ].join('\n')
}

export function explainTablePrompt(path: string, sheet: string) {
  return [
    `解释${where(path, sheet)}：`,
    '这张表是配什么的、主键是什么、每一列大概的用途（分组说）、和哪些表互相引用、新加一行时要注意什么。',
    '用 table.sample / table.query 读，按结构和数据推断，拿不准的地方标出来。只读，不要改任何文件。回答简洁，用中文。',
  ].join('\n')
}

/** 修检查出的问题：最多列这么多处，多了让 Agent 自己 table.check / table.query 看 */
const MAX_LIST = 60

export function fixProblemsPrompt(path: string, sheet: string, problems: (Problem & { field: string })[]) {
  const list = problems
    .slice(0, MAX_LIST)
    .map((p) => `- 第 ${p.r + 1} 行 ${p.field || `第 ${p.c + 1} 列`}：${p.msg}`)
    .join('\n')
  return [
    `${where(path, sheet)}按表格结构检查有 ${problems.length} 处不合规：`,
    list + (problems.length > MAX_LIST ? `\n……还有 ${problems.length - MAX_LIST} 处` : ''),
    '逐处看清楚原因再改：能从上下文、同类行、被引用的表确定正确值的就改；确定不了的不要猜，在 note 和回复里列出来让用户决定。',
    PROPOSE,
  ].join('\n\n')
}
