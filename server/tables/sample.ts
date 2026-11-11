/**
 * AI 分析表格风格用的样本：挑几张表（不同目录各取一些），每张表开头几行；
 * 再把所有表里「类型行」上的非基础类型名在那一列出现过的值汇总（给 AI 判断枚举用）。
 * 只读文件，不写任何东西。
 */
import path from 'node:path'
import { detectSheetHeader } from '../../shared/sheet-header.ts'
import type { TableFile } from '../../shared/tables.ts'
import { parseTable } from './files.ts'

const FILES = 10
const ROWS = 14
const COLS = 30
const CELL = 40
/** 每个类型名最多收这么多个不同的值 */
const VALUES = 120
const TYPES = 60
/** 交给 CLI 的样本最长这么多字（AssistInput.subject 每项上限 60000） */
const MAX_TEXT = 50000
const BASIC = /^(s?int(8|16|32|64)?|uint(8|16|32|64)?|u?long|u?short|byte|float|double|bool(ean)?|string|bytes|text)$/i

/** 挑样本：按目录轮着取，免得全是同一个目录的 */
function pick(files: TableFile[]) {
  const byDir = new Map<string, TableFile[]>()
  for (const f of files.filter((x) => x.kind !== 'xls')) {
    const d = path.posix.dirname(f.path)
    byDir.set(d, [...(byDir.get(d) ?? []), f])
  }
  const out: TableFile[] = []
  const lists = [...byDir.values()]
  for (let i = 0; out.length < FILES && lists.some((l) => l.length > i); i++)
    for (const l of lists) if (l[i] && out.length < FILES) out.push(l[i])
  return out
}

const cut = (s: string) => (s.length > CELL ? `${s.slice(0, CELL)}…` : s).replace(/[\t\n\r]/g, ' ')

export async function tableSample(dir: string, files: TableFile[]): Promise<{ text: string; files: number }> {
  const parts: string[] = []
  const chosen = pick(files)
  for (const f of chosen) {
    let sheets
    try {
      sheets = (await parseTable(path.join(dir, f.path))).sheets
    } catch {
      continue
    }
    for (const s of sheets.slice(0, 2)) {
      const lines = s.rows.slice(0, ROWS).map((r, i) => `${i + 1}\t${r.slice(0, COLS).map(cut).join('\t')}`)
      parts.push(`### ${f.path}${sheets.length > 1 ? ` · ${s.name}` : ''}（${s.rows.length} 行）\n${lines.join('\n')}`)
    }
  }
  // 类型名 → 出现过的值：所有表都看（解析有缓存）
  const values = new Map<string, Set<string>>()
  for (const f of files) {
    if (f.kind === 'xls' || values.size >= TYPES) continue
    let sheets
    try {
      sheets = (await parseTable(path.join(dir, f.path))).sheets
    } catch {
      continue
    }
    for (const s of sheets) {
      const h = detectSheetHeader(s.rows)
      const ti = h.roles.indexOf('type')
      if (ti < 0) continue
      const types = s.rows[h.start + ti] ?? []
      const from = h.start + h.roles.length
      types.forEach((type, c) => {
        const name = type.trim()
        if (!/^[A-Z][A-Za-z0-9_]+$/.test(name) || BASIC.test(name)) return
        const set = values.get(name) ?? new Set<string>()
        if (!values.has(name)) {
          if (values.size >= TYPES) return
          values.set(name, set)
        }
        for (let r = from; r < s.rows.length && set.size < VALUES; r++) {
          for (const v of (s.rows[r]?.[c] ?? '').split(/[;|,]/)) if (v.trim()) set.add(v.trim())
        }
      })
    }
  }
  if (values.size)
    parts.push(
      `### 类型名在各表里出现过的值\n${[...values]
        .map(([k, v]) => `${k}: ${[...v].slice(0, VALUES).join(', ')}${v.size >= VALUES ? ' …' : ''}`)
        .join('\n')}`,
    )
  const text = parts.join('\n\n')
  return {
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…（样本太长，后面省略）` : text,
    files: chosen.length,
  }
}
