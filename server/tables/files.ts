/**
 * 表格页的文件层：按项目设置的表格目录列出表格文件、解析（带缓存）、跨文件按内容搜索。
 * 只读：写回在 server/tables/write.ts。解析结果按「修改时间 + 大小」缓存，内容搜索第一次全量解析、之后只重读变过的文件。
 */
import path from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { t } from '../../shared/i18n.ts'
import { csvFormat, parseCsv } from '../../shared/csv.ts'
import {
  TABLE_EXCLUDE,
  globHit,
  globList,
  tableKind,
  type TableDoc,
  type TableFile,
  type TableHit,
  type TableSearch,
  type TablesConfig,
  type TablesIndex,
} from '../../shared/tables.ts'
import type { SheetData } from '../../shared/files.ts'
import { MAX_XLSX_BYTES, readXlsx } from '../xlsx.ts'

/** 一个项目最多列这么多个表格文件 */
const MAX_FILES = 5000
/** 内容搜索最多给这么多处命中 */
const MAX_HITS = 500
/** 解析缓存最多留这么多个单元格（所有文件合计）；超了丢掉最久没用的 */
const CACHE_CELLS = 6_000_000
/** 不往里走的目录 */
const SKIP_DIRS = new Set(['.git', '.svn', '.p4', 'node_modules', '.agentpanel'])

const norm = (p: string) => p.replace(/\\/g, '/')

/** 表格目录里的相对路径不能跑出项目目录 */
export function safeRel(dir: string, rel: string) {
  const n = norm(rel).replace(/^\.\/+/, '')
  if (!n || path.isAbsolute(n) || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..'))
    throw new Error(t('只能查看项目目录里的文件'))
  return { rel: n, full: path.join(dir, n) }
}

/** 列出表格目录里的全部表格文件（按路径排序） */
export async function listTables(dir: string, cfg: TablesConfig): Promise<TablesIndex> {
  const include = globList(cfg.include)
  const exclude = globList(cfg.exclude || TABLE_EXCLUDE)
  const files: TableFile[] = []
  const dirs: string[] = []
  const missing: string[] = []
  let truncated = false
  const seen = new Set<string>()
  async function walk(rel: string) {
    if (files.length >= MAX_FILES) {
      truncated = true
      return
    }
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !globHit(child, exclude)) await walk(child)
        continue
      }
      if (!e.isFile() || seen.has(child)) continue
      const kind = tableKind(e.name)
      if (!kind || !globHit(child, include) || globHit(child, exclude)) continue
      const info = await stat(path.join(dir, child)).catch(() => null)
      if (!info) continue
      seen.add(child)
      files.push({ path: child, kind, size: info.size, mtime: info.mtime.toISOString() })
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
    }
  }
  for (const d of cfg.dirs) {
    let rel: string
    try {
      rel = safeRel(dir, d).rel.replace(/\/+$/, '')
    } catch {
      missing.push(d)
      continue
    }
    const ok = await stat(path.join(dir, rel))
      .then((s) => s.isDirectory())
      .catch(() => false)
    if (!ok) {
      missing.push(d)
      continue
    }
    dirs.push(rel)
    await walk(rel)
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
  return { dirs, missing, files, ...(truncated ? { truncated } : {}) }
}

interface Cached {
  key: string
  sheets: SheetData[]
  cells: number
  csv?: TableDoc['csv']
}
const cache = new Map<string, Cached>()
let cachedCells = 0

const countCells = (sheets: SheetData[]) => sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.length, 0), 0)

function remember(full: string, c: Cached) {
  const old = cache.get(full)
  if (old) cachedCells -= old.cells
  cache.delete(full)
  cache.set(full, c)
  cachedCells += c.cells
  // Map 按插入顺序：最前面的是最久没用的
  for (const [k, v] of cache) {
    if (cachedCells <= CACHE_CELLS || k === full) break
    cache.delete(k)
    cachedCells -= v.cells
  }
}

/** 文件改过（保存、外部改动）后让缓存失效 */
export const forgetTable = (full: string) => {
  const old = cache.get(full)
  if (old) cachedCells -= old.cells
  cache.delete(full)
}

/** 解析一个表格文件（xlsx / csv），带缓存 */
export async function parseTable(full: string): Promise<{ sheets: SheetData[]; csv?: TableDoc['csv'] }> {
  const info = await stat(full)
  const key = `${info.mtimeMs}:${info.size}`
  const hit = cache.get(full)
  if (hit && hit.key === key) {
    // 用了一次：挪到最后（最近用过）
    cache.delete(full)
    cache.set(full, hit)
    return hit
  }
  if (tableKind(full) === 'xlsx' && info.size > MAX_XLSX_BYTES)
    throw new Error(t('表格太大（超过 30 MB），请用表格软件打开'))
  const { sheets, csv } = await parseTableBuffer(full, await readFile(full))
  const c: Cached = { key, sheets, cells: countCells(sheets), csv }
  remember(full, c)
  return c
}

/** 按文件名认格式解析一份内容（磁盘上的文件、版本控制里取出的旧版本都用它），不缓存 */
export async function parseTableBuffer(
  name: string,
  buf: Buffer,
): Promise<{ sheets: SheetData[]; csv?: TableDoc['csv'] }> {
  const kind = tableKind(name)
  if (kind === 'xlsx') {
    if (buf.length > MAX_XLSX_BYTES) throw new Error(t('表格太大（超过 30 MB），请用表格软件打开'))
    return { sheets: readXlsx(buf) }
  }
  if (kind === 'csv') {
    const text = buf.toString('utf8')
    const csv = csvFormat(text, /\.tsv$/i.test(name))
    return { csv, sheets: [{ name: path.basename(name).replace(/\.[^.]+$/, ''), rows: parseCsv(text, csv.delimiter) }] }
  }
  throw new Error(t('老的 .xls / .et 格式只能用表格软件打开，另存为 .xlsx 后能在这里看和改'))
}

/** 同目录有 Office / WPS 的锁文件（~$ 开头）：文件正被打开 */
export async function lockedByOffice(full: string) {
  const base = path.basename(full)
  const dir = path.dirname(full)
  // Excel 用「~$」+ 原名（长名字会去掉前两个字），WPS 用「.~」+ 原名
  const names = [`~$${base}`, `~$${base.slice(2)}`, `.~${base}`]
  for (const n of names)
    if (
      await stat(path.join(dir, n))
        .then(() => true)
        .catch(() => false)
    )
      return true
  return false
}

/** 打开一个表格文件给表格页 */
export async function openTable(dir: string, rel: string, cfg: TablesConfig): Promise<TableDoc> {
  const { rel: r, full } = safeRel(dir, rel)
  const kind = tableKind(r)
  if (!kind) throw new Error(t('不是表格文件'))
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new Error(t('文件不存在，可能已删除或路径写错：{path}', { path: r }))
  const base = { path: r, kind, size: info.size, mtime: info.mtime.toISOString() }
  if (kind === 'xls')
    return { ...base, sheets: [], readOnly: t('老的 .xls / .et 格式只能用表格软件打开，另存为 .xlsx 后能在这里看和改') }
  const { sheets, csv } = await parseTable(full)
  const truncated = sheets.some((s) => s.truncated)
  const readOnly = cfg.readOnly
    ? t('项目设置里把表格设成了只读')
    : truncated
      ? t('表格太大，只读了前面一部分，不能在这里改')
      : undefined
  return { ...base, sheets, csv, ...(readOnly ? { readOnly } : {}), locked: await lockedByOffice(full) }
}

/** 在全部表格文件里按内容找（不区分大小写），命中按文件顺序 */
export async function searchTables(dir: string, files: TableFile[], q: string): Promise<TableSearch> {
  const needle = q.trim().toLowerCase()
  const hits: TableHit[] = []
  let searched = 0
  if (!needle) return { hits, files: 0 }
  for (const f of files) {
    if (f.kind === 'xls') continue
    let sheets: SheetData[]
    try {
      sheets = (await parseTable(path.join(dir, f.path))).sheets
    } catch {
      continue
    }
    searched++
    for (const s of sheets)
      for (let r = 0; r < s.rows.length; r++) {
        const row = s.rows[r]
        for (let c = 0; c < row.length; c++) {
          const v = row[c]
          if (!v || !v.toLowerCase().includes(needle)) continue
          hits.push({ path: f.path, sheet: s.name, row: r, col: c, text: v.length > 200 ? `${v.slice(0, 200)}…` : v })
          if (hits.length >= MAX_HITS) return { hits, files: searched, truncated: true }
        }
      }
  }
  return { hits, files: searched }
}
