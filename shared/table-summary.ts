/**
 * 提交说明的改动小结：按格子级差异直接拼，不用 AI。
 * 「C_HomeDecorationConfig：改 3 格（DisplayName ×2、Level ×1），加 2 行」；多张工作表时每张一段
 */
import { t } from './i18n.ts'
import type { SheetDiff } from './sheet-diff.ts'

/** 括号里最多列几个字段 */
const MAX_FIELDS = 5

export function changeSummary(file: string, sheets: { sheet: string; diff: SheetDiff; names: string[] }[]) {
  const base = file.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
  const parts = sheets.flatMap(({ sheet, diff, names }) => {
    const { cells, add, del } = diff.stats
    if (!cells && !add && !del) return []
    const bits: string[] = []
    if (cells) {
      const per = new Map<string, number>()
      for (const r of diff.rows)
        for (const c of r.cols ?? []) {
          const f = names[c]?.trim() || t('第 {n} 列', { n: c + 1 })
          per.set(f, (per.get(f) ?? 0) + 1)
        }
      const list = [...per].sort((a, b) => b[1] - a[1])
      const shown = list
        .slice(0, MAX_FIELDS)
        .map(([f, n]) => `${f} ×${n}`)
        .join('、')
      bits.push(
        t('改 {n} 格（{fields}）', {
          n: cells,
          fields: list.length > MAX_FIELDS ? `${shown}…` : shown,
        }),
      )
    }
    if (add) bits.push(t('加 {n} 行', { n: add }))
    if (del) bits.push(t('删 {n} 行', { n: del }))
    return [{ sheet, text: bits.join('，') }]
  })
  if (!parts.length) return ''
  if (parts.length === 1 && sheets.length === 1) return `${base}：${parts[0].text}`
  return [`${base}：`, ...parts.map((p) => `- ${p.sheet}：${p.text}`)].join('\n')
}
