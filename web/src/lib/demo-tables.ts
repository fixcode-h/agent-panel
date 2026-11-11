/**
 * 在线演示的表格页接口（正式版是 server/tables/*）：表格就是演示项目里的 xlsx 和 CSV，
 * 改动、结构文件只存在这一页的内存里，刷新就回到示例数据。
 */
import { parseCsv } from '@shared/csv'
import { applyRowOps, setCells, type TableSave } from '@shared/table-edit'
import { checkWorkbook } from '@shared/table-struct'
import type { Project } from '@shared/schema'
import {
  TableSchema,
  TablesConfig,
  globHit,
  globList,
  tableKind,
  tablesOn,
  type TableDoc,
  type TableFile,
  type TableHit,
} from '@shared/tables'
import type { SheetData } from '@shared/files'
import { DEMO_CSV, DEMO_FILES, DEMO_SHEETS } from './demo-project-files'
import { fail } from './demo-http'
import { DEMO_REVS, demoAt, demoRelease } from './demo-table-versions'

const MTIME = '2026-11-10T08:00:00.000Z'
/** 每个文件的内容和修改时间（保存后更新） */
const books = new Map<string, { sheets: SheetData[]; mtime: string }>()
/** 演示的结构文件：一个手写的枚举、一个从枚举表取值的枚举、一列引用角色表、一列有取值范围 */
const DEMO_SCHEMA = {
  style: { key: 'ID', listSep: ';', primitives: ['uint32', 'int32', 'bytes', 'string'] },
  enums: {
    HomeDecorationMountType: {
      values: [
        { name: 'FloorMirror', value: '1', desc: '落地' },
        { name: 'WallMirror', value: '2', desc: '挂墙' },
        { name: 'TabletopDecor', value: '3', desc: '桌面' },
      ],
    },
    HomeDecorationSizeType: {
      values: [],
      source: {
        file: 'data/enum/E_HomeDecoration.xlsx',
        match: { col: 'EnumName', value: 'HomeDecorationSizeType' },
        nameCol: 'Name',
        valueCol: 'Value',
        descCol: 'Desc',
      },
    },
  },
  columns: {
    'data/C_HomeDecorationConfig.xlsx#*#InteractionAllowCharacterIDs': { ref: 'data/character/C_Character.xlsx#ID' },
    'data/C_HomeDecorationConfig.xlsx#*#InteractionTriggerState': { min: 0, max: 1, allow: ['-1'] },
  },
}
let schema = TableSchema.parse(DEMO_SCHEMA)

/** 示例表原样（版本记录里的 HEAD） */
function pristine(path: string) {
  const sheets = DEMO_SHEETS[path] ?? (path.endsWith('.csv') ? [{ name: 'products', rows: parseCsv(DEMO_CSV) }] : null)
  if (!sheets) fail(`文件不存在，可能已删除或路径写错：${path}`)
  return sheets!
}

/** 客户端主工程当作同一个游戏的 Release 工作区：同一批表，改动少一些（跨项目对比演示它） */
const isRelease = (p?: Project) => !!p?.path.includes('game-client')

function bookOf(path: string, p?: Project) {
  const key = `${isRelease(p) ? 'release:' : ''}${path}`
  let b = books.get(key)
  if (!b) {
    const base = pristine(path)
    b = { sheets: structuredClone(isRelease(p) ? demoRelease(path, base) : base), mtime: MTIME }
    books.set(key, b)
  }
  return b
}

/** 演示的保存（三期）也从这里改内容 */
export const demoBook = (path: string) => bookOf(path)
export const demoSchema = {
  get: () => schema,
  set: (s: TableSchema) => (schema = TableSchema.parse(s)),
}

function filesOf(p: Project): TableFile[] {
  const cfg = p.tables
  if (!tablesOn(cfg)) return []
  const include = globList(cfg.include)
  const exclude = globList(cfg.exclude)
  return DEMO_FILES.filter(
    (f) =>
      cfg.dirs.some((d) => f.startsWith(`${d.replace(/\/+$/, '').replace(`${p.path}/`, '')}/`)) &&
      tableKind(f) &&
      globHit(f, include) &&
      !globHit(f, exclude),
  ).map((f) => ({ path: f, kind: tableKind(f)!, size: 24_000, mtime: bookOf(f, p).mtime }))
}

/** 项目设置里按还没保存的配置找一遍：演示项目的文件都在项目目录里，绝对路径换成相对的再找 */
function demoProbe(p: Project, body: unknown) {
  const b = (body ?? {}) as { path?: string; tables?: unknown }
  const base = (b.path?.trim() || p.path).replace(/\/+$/, '')
  const cfg = TablesConfig.parse(b.tables ?? {})
  const files = filesOf({ ...p, tables: cfg })
  const rel = (d: string) => (d.startsWith('/') ? (d.startsWith(`${base}/`) ? d.slice(base.length + 1) : null) : d)
  const roots = cfg.dirs.map((d) => {
    const r = rel(d)
    const full = d.startsWith('/') ? d : `${base}/${d}`
    const n = r === null ? 0 : DEMO_FILES.filter((f) => f.startsWith(`${r}/`) && tableKind(f)).length
    return { dir: d, full, found: r !== null && DEMO_FILES.some((f) => f.startsWith(`${r}/`)), files: n }
  })
  return { roots, files: files.length, sample: files.slice(0, 5).map((f) => f.path) }
}

export function demoTables(
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: unknown,
  p: Project,
  others: (id: string) => Project | undefined,
): unknown {
  const kind = seg[2]
  if (kind === 'probe' && method === 'POST') return demoProbe(p, body)
  if (!kind && method === 'GET') return { dirs: p.tables?.dirs ?? [], missing: [], files: filesOf(p) }
  if (kind === 'file') {
    const path = query.get('path') ?? ''
    const b = bookOf(path, p)
    const doc: TableDoc = {
      path,
      kind: tableKind(path) ?? 'xlsx',
      sheets: b.sheets,
      size: 24_000,
      mtime: b.mtime,
      ...(p.tables?.readOnly ? { readOnly: '项目设置里把表格设成了只读' } : {}),
      ...(path.endsWith('.csv') ? { csv: { delimiter: ',', eol: 'lf' as const, bom: false } } : {}),
    }
    return doc
  }
  if (kind === 'search') {
    const needle = (query.get('q') ?? '').trim().toLowerCase()
    const hits: TableHit[] = []
    const files = filesOf(p)
    if (needle)
      for (const f of files)
        for (const s of bookOf(f.path, p).sheets)
          s.rows.forEach((row, r) =>
            row.forEach((v, c) => {
              if (v && v.toLowerCase().includes(needle) && hits.length < 500)
                hits.push({ path: f.path, sheet: s.name, row: r, col: c, text: v })
            }),
          )
    return { hits, files: files.length }
  }
  if (kind === 'save' && method === 'POST') {
    const save = body as TableSave
    const b = bookOf(save.path, p)
    if (p.tables?.readOnly) fail('项目设置里把表格设成了只读')
    if (save.mtime !== b.mtime && !save.force)
      fail('打开之后文件在外面被改过了：重新载入看看最新的内容，或者只把改了的格子写进去')
    b.sheets = b.sheets.map((s) => {
      const e = save.sheets.find((x) => x.name === s.name) ?? (save.path.endsWith('.csv') ? save.sheets[0] : undefined)
      return e ? { ...s, rows: setCells(applyRowOps(s.rows, e.rows), e.cells) } : s
    })
    b.mtime = new Date().toISOString()
    return demoTables('GET', [seg[0], seg[1], 'file'], new URLSearchParams({ path: save.path }), null, p, others)
  }
  // AI 分析：不带 path 是挑出来的表的清单，带 path 是一张表的表头 + 前几行（和正式版一样一张一张看）
  if (kind === 'sample' && method === 'GET') {
    const one = query.get('path')
    if (one)
      return {
        files: 1,
        text: bookOf(one, p)
          .sheets.map(
            (s) =>
              `### ${one}\n${s.rows
                .slice(0, 8)
                .map((r, i) => `${i + 1}\t${r.join('\t')}`)
                .join('\n')}`,
          )
          .join('\n\n'),
      }
    const files = filesOf(p)
      .filter((f) => f.kind !== 'xls')
      .slice(0, 8)
    const text = files.map((f) => `- ${f.path}（${bookOf(f.path, p).sheets.length} 张工作表）`).join('\n')
    return { text, files: files.length }
  }
  if (kind === 'check' && method === 'GET') {
    const files = filesOf(p).filter((f) => f.kind !== 'xls')
    const sheetsOf = (f: string) => (DEMO_FILES.includes(f) ? bookOf(f, p).sheets : undefined)
    return {
      files: files.length,
      failed: [],
      sheets: files.flatMap((f) => checkWorkbook(schema, f.path, bookOf(f.path, p).sheets, sheetsOf)),
    }
  }
  // 版本记录：演示里当作 Git 管着，三个提交（见 demo-table-versions.ts）
  if (kind === 'history' && method === 'GET') return { vcs: 'git', base: 'HEAD', revs: DEMO_REVS }
  if (kind === 'at' && method === 'GET') {
    const path = query.get('path') ?? ''
    return { sheets: demoAt(path, query.get('rev') ?? '', pristine(path)) }
  }
  // 跨项目对比：按相对路径配对，比格子
  if (kind === 'compare' && method === 'GET') {
    const other = others(query.get('other') ?? '')
    if (!other || !tablesOn(other.tables)) fail('两个项目都要先设好表格目录')
    const left = new Map(filesOf(p).map((f) => [f.path, f]))
    const right = new Map(filesOf(other!).map((f) => [f.path, f]))
    const pairs = [...new Set([...left.keys(), ...right.keys()])].sort().map((path) => {
      if (!right.has(path)) return { path, status: 'left' }
      if (!left.has(path)) return { path, status: 'right' }
      const same = JSON.stringify(bookOf(path, p).sheets) === JSON.stringify(bookOf(path, other).sheets)
      return { path, status: same ? 'same' : 'diff' }
    })
    return { pairs }
  }
  if (kind === 'schema' && method === 'GET') return schema
  if (kind === 'schema' && method === 'PUT') return demoSchema.set(body as TableSchema)
  return fail('在线演示不支持这个表格操作')
}
