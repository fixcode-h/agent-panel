/**
 * 跨项目对比导出成报告（CSV，Excel / WPS 直接打开）：文件清单（每个文件的状态），
 * 和一对文件的格子级差异（哪一行、哪个字段、右边的值、左边的值）
 */
import { t } from '@shared/i18n'
import { sheetCsv } from '@shared/table-io'
import type { SheetDiff } from '@shared/sheet-diff'
import type { TablePair } from '@/lib/tables-api'

export function pairsReport(pairs: TablePair[], label: (s: TablePair['status']) => string, l: string, r: string) {
  return sheetCsv([
    [t('文件'), t('状态'), t('左边（{name}）的路径', { name: l }), t('右边（{name}）的路径', { name: r }), t('出错')],
    ...pairs.map((p) => [p.path, label(p.status), p.left ?? p.path, p.right ?? p.path, p.error ?? '']),
  ])
}

/** 差异是 右(旧) a → 左(新) b */
export function diffReport(sheet: string, diff: SheetDiff, a: string[][], b: string[][], names: string[]) {
  const kc = diff.key ? names.indexOf(diff.key) : -1
  const keyOf = (row: string[] | undefined, n: number | undefined) =>
    kc >= 0 ? (row?.[kc] ?? '') : n === undefined ? '' : String(n + 1)
  const out: string[][] = [[t('工作表'), t('变化'), diff.key || t('行'), t('字段'), t('右边（旧）'), t('左边（新）')]]
  const KIND = { add: t('只在左边'), del: t('只在右边'), mod: t('改了') }
  for (const row of diff.rows) {
    if (row.kind === 'same') continue
    const ar = row.a === undefined ? undefined : a[row.a]
    const br = row.b === undefined ? undefined : b[row.b]
    const key = keyOf(br ?? ar, row.b ?? row.a)
    if (row.kind === 'mod')
      for (const c of row.cols ?? [])
        out.push([sheet, KIND.mod, key, names[c] ?? '', ar?.[diff.colMap[c]] ?? '', br?.[c] ?? ''])
    else
      out.push([
        sheet,
        KIND[row.kind],
        key,
        '',
        row.kind === 'del' ? (ar ?? []).join(' | ') : '',
        row.kind === 'add' ? (br ?? []).join(' | ') : '',
      ])
  }
  return sheetCsv(out)
}
