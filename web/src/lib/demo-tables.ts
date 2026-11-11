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
import { DEMO_CONFLICT, DEMO_REVS, demoAt, demoConflict, demoRelease } from './demo-table-versions'
import { exportLines, type ExportEvent } from '@shared/table-export'
import { enumRenameCells, type EnumRename } from '@shared/table-enum-rename'
import { cellChanges, cellIn, type CellAt } from '@shared/table-blame'
import { cellDiffCount, columnSync } from '@shared/table-sync'

function demoExport(p: Project, b: { script: number; paths: string[] }): ExportEvent[] {
  const script = p.tables?.exports[b.script]
  if (!script) fail('找不到这个导表脚本，可能刚在项目设置里删了')
  const lines = exportLines(
    script!.command,
    b.paths.map((x) => ({ file: `${p.path}/${x}`, rel: x })),
    p.path,
    'sh',
  )
  return [
    ...lines.flatMap((line, index): ExportEvent[] => {
      const name = b.paths[index] ?? b.paths.join(' ')
      return [
        { type: 'start', line, index, total: lines.length },
        { type: 'out', text: `读取 ${name}` },
        { type: 'out', text: `导出 ${name.replace(/.*\//, '').replace(/\.[^.]+$/, '')}.json，共 ${12 + index * 7} 行` },
        { type: 'end', index, code: 0 },
      ]
    }),
    { type: 'done', ok: true },
  ]
}

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
/** 演示的版本状态：提交时文件的修改时间、标记过冲突解决的项目 */
const demoCommitted = new Map<string, string>()
const demoResolved = new Set<string>()

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
  if (kind === 'stat') return { mtime: bookOf(query.get('path') ?? '', p).mtime, size: 24_000 }
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
      sheets: files.flatMap((f) =>
        checkWorkbook(schema, f.path, bookOf(f.path, p).sheets, sheetsOf, query.get('all') === '1' ? 100_000 : 20),
      ),
    }
  }
  // 版本记录：演示里当作 Git 管着，三个提交（见 demo-table-versions.ts）
  if (kind === 'history' && method === 'GET') return { vcs: 'git', base: 'HEAD', revs: DEMO_REVS }
  if (kind === 'at' && method === 'GET') {
    const path = query.get('path') ?? ''
    return { sheets: demoAt(path, query.get('rev') ?? '', pristine(path)) }
  }
  if (kind === 'cell-history' && method === 'GET') {
    const path = query.get('path') ?? ''
    const at: CellAt = {
      sheet: query.get('sheet') ?? '',
      field: query.get('field') ?? '',
      keyField: query.get('keyField') || undefined,
      key: query.get('key') || undefined,
      row: Number(query.get('row')) || 0,
    }
    const values = DEMO_REVS.map((r) => cellIn(schema, path, demoAt(path, r.id, pristine(path)), at))
    return { vcs: 'git', changes: cellChanges(DEMO_REVS, values), scanned: values.length }
  }
  // 版本状态：改过（修改时间变了）算有改动；角色表演示冲突，标记解决后才能提交
  if (kind === 'vcs-status' && method === 'GET') {
    const path = query.get('path') ?? ''
    const conflict = path === DEMO_CONFLICT && !demoResolved.has(p.id)
    return {
      vcs: 'git',
      changed: conflict || bookOf(path, p).mtime !== (demoCommitted.get(`${p.id}:${path}`) ?? MTIME),
      conflict,
    }
  }
  if (kind === 'vcs-submit' && method === 'POST') {
    const b = body as { path: string; message: string }
    if (!b.message.trim()) fail('写一句提交说明')
    demoCommitted.set(`${p.id}:${b.path}`, bookOf(b.path, p).mtime)
    return { vcs: 'git', out: '' }
  }
  if (kind === 'merge-start' && method === 'POST') {
    const b = body as { path: string }
    if (b.path !== DEMO_CONFLICT || demoResolved.has(p.id)) fail('这个文件没有冲突')
    return { vcs: 'git', ...demoConflict(pristine(b.path)), theirsLabel: 'a7c31e0f', replaced: false }
  }
  if (kind === 'vcs-resolve' && method === 'POST') {
    demoResolved.add(p.id)
    return { vcs: 'git', changed: true, conflict: false }
  }
  // 切换到某一版：演示里直接把内容换成那一版
  if (kind === 'checkout' && method === 'POST') {
    const b = body as { path: string; rev: string }
    if (p.tables?.readOnly) fail('项目设置里把表格设成了只读')
    const book = bookOf(b.path, p)
    book.sheets = structuredClone(demoAt(b.path, b.rev, pristine(b.path)))
    book.mtime = new Date().toISOString()
    return demoTables('GET', [seg[0], seg[1], 'file'], new URLSearchParams({ path: b.path }), null, p, others)
  }
  // 导表：演示不真的执行，按配好的命令拼出要跑的几行，给出一段像样的输出（页面会一条一条放出来）
  if (kind === 'export' && method === 'POST') return demoExport(p, body as { script: number; paths: string[] })
  // 枚举值改名：演示里直接改内存里的表
  if (kind === 'enum-rename' && method === 'POST') {
    const b = body as { renames: EnumRename[]; apply: boolean }
    const files = filesOf(p)
      .filter((f) => f.kind !== 'xls')
      .flatMap((f) => {
        const book = bookOf(f.path, p)
        const per = book.sheets.map((s) => enumRenameCells(schema, f.path, s, b.renames))
        const n = per.reduce((m, c) => m + c.length, 0)
        if (!n) return []
        if (b.apply) {
          book.sheets = book.sheets.map((s, i) => (per[i].length ? { ...s, rows: setCells(s.rows, per[i]) } : s))
          book.mtime = new Date().toISOString()
        }
        return [{ path: f.path, cells: n }]
      })
    return { files, failed: [], applied: b.apply }
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
  // 跨项目批量同步：演示里改内存里右边项目的表
  if (kind === 'sync' && method === 'POST') {
    const b = body as {
      other: string
      items: { path: string }[]
      mode: 'file' | 'column'
      field?: string
      apply: boolean
    }
    const other = others(b.other)
    if (!other || !tablesOn(other.tables)) fail('两个项目都要先设好表格目录')
    if (b.mode === 'column' && !b.field?.trim()) fail('写要同步的字段名')
    const results = b.items.map((it) => {
      const known = filesOf(other!).some((f) => f.path === it.path)
      const lb = bookOf(it.path, p)
      if (b.mode === 'file') {
        const rb = known ? bookOf(it.path, other) : null
        const cells = rb ? cellDiffCount(lb.sheets, rb.sheets) : 0
        if (rb && !cells) return { path: it.path, action: 'same', cells: 0 }
        if (b.apply && rb) {
          rb.sheets = structuredClone(lb.sheets)
          rb.mtime = new Date().toISOString()
        }
        return { path: it.path, action: rb ? 'replace' : 'create', cells }
      }
      if (!known) return { path: it.path, action: 'skip', cells: 0, error: '右边没有这个文件' }
      const rb = bookOf(it.path, other)
      const per = columnSync(
        { schema, file: it.path, sheets: lb.sheets },
        { schema, file: it.path, sheets: rb.sheets },
        b.field!.trim(),
      )
      if (!per.length) return { path: it.path, action: 'skip', cells: 0, error: '两边没有都带这一列和主键列的工作表' }
      const cells = per.reduce((n, x) => n + x.cells.length, 0)
      if (b.apply && cells) {
        rb.sheets = rb.sheets.map((s) => {
          const x = per.find((y) => y.sheet === s.name)
          return x?.cells.length
            ? {
                ...s,
                rows: setCells(
                  s.rows.map((r) => [...r]),
                  x.cells,
                ),
              }
            : s
        })
        rb.mtime = new Date().toISOString()
      }
      return { path: it.path, action: cells ? 'cells' : 'same', cells, missing: per.reduce((n, x) => n + x.missing, 0) }
    })
    return { results }
  }
  if (kind === 'schema' && method === 'GET') return schema
  if (kind === 'schema' && method === 'PUT') return demoSchema.set(body as TableSchema)
  return fail('在线演示不支持这个表格操作')
}
