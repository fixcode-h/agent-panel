/**
 * 保存表格页的改动：在磁盘上的文件上照做「行操作 + 改格子」，写到临时文件、重新解析、
 * 和预期逐格比对，对上了才备份原文件、替换。文件格式（xlsx / CSV 的分隔符、换行、BOM）保持原样。
 * 保存前检查：项目设了只读、文件正被 Excel / WPS 打开、打开后被外面改过（修改时间对不上）。
 * P4 管着的只读文件先 p4 edit。
 */
import path from 'node:path'
import { access, constants, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { t } from '../../shared/i18n.ts'
import { csvFormat, parseCsv, writeCsv } from '../../shared/csv.ts'
import { applyRowOps, cellRef, gridDiff, setCells, type TableSave } from '../../shared/table-edit.ts'
import { tableKind, type TableDoc, type TablesConfig } from '../../shared/tables.ts'
import { DATA_DIR } from '../store.ts'
import { readXlsx } from '../xlsx.ts'
import { forgetTable, lockedByOffice, openTable, safeRel } from './files.ts'
import { editXlsx } from './xlsx-write.ts'
import { HttpError } from './http-error.ts'

/** 每个文件保留最近几份备份 */
const KEEP_BACKUPS = 20

export interface SaveDeps {
  /** P4 管着的文件：签出（p4 edit）；不是 P4 项目时返回 false */
  p4Edit?: (full: string) => Promise<{ ok: boolean; err: string } | false>
}

/** 备份到数据目录 tables-backup/<项目 id>/，按文件名 + 时间；只留最近的几份 */
async function backup(projectId: string, rel: string, full: string) {
  // 项目目录外的表格（绝对路径）：盘符的冒号去掉，Windows 上目录名不能带冒号
  const sub = path
    .dirname(rel)
    .replace(/^([a-zA-Z]):/, '$1')
    .replace(/^\/+/, '')
  const dir = path.join(DATA_DIR, 'tables-backup', projectId, sub)
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = path.basename(rel)
  await copyFile(full, path.join(dir, `${stamp}~${name}`))
  const old = (await readdir(dir)).filter((f) => f.endsWith(`~${name}`)).sort()
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await rm(path.join(dir, f), { force: true })
}

/** 改完后应该是什么样：用原文件解析出来的表做同样的操作 */
function expected(sheets: { name: string; rows: string[][] }[], body: TableSave) {
  const out = new Map<string, string[][]>()
  for (const e of body.sheets) {
    const s = sheets.find((x) => x.name === e.name)
    if (!s) throw new HttpError(t('找不到工作表：{name}', { name: e.name }))
    out.set(e.name, setCells(applyRowOps(s.rows, e.rows), e.cells))
  }
  return out
}

export async function saveTable(
  dir: string,
  projectId: string,
  cfg: TablesConfig,
  body: TableSave,
  deps: SaveDeps = {},
): Promise<TableDoc> {
  if (cfg.readOnly) throw new HttpError(t('项目设置里把表格设成了只读'), 409)
  const { rel, full } = safeRel(dir, body.path, cfg)
  const kind = tableKind(rel)
  if (kind !== 'xlsx' && kind !== 'csv')
    throw new HttpError(t('老的 .xls / .et 格式只能用表格软件打开，另存为 .xlsx 后能在这里看和改'))
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new HttpError(t('文件不存在，可能已删除或路径写错：{path}', { path: rel }), 404)
  if (await lockedByOffice(full))
    throw new HttpError(t('文件正在 Excel / WPS 里打开，先在那边关掉再保存（不然那边保存时会把这里的改动盖掉）'), 409)
  const moved = info.mtime.toISOString() !== body.mtime
  if (moved && (!body.force || body.sheets.some((s) => s.rows.length)))
    throw new HttpError(t('打开之后文件在外面被改过了：重新载入看看最新的内容，或者只把改了的格子写进去'), 409)

  const buf = await readFile(full)
  let next: Buffer
  let want: Map<string, string[][]>
  if (kind === 'csv') {
    const text = buf.toString('utf8')
    const f = csvFormat(text, /\.tsv$/i.test(rel))
    const sheets = [{ name: path.basename(rel).replace(/\.[^.]+$/, ''), rows: parseCsv(text, f.delimiter) }]
    // CSV 只有一张表：页面上表名就是文件名
    want = expected(sheets, { ...body, sheets: body.sheets.map((s) => ({ ...s, name: sheets[0].name })) })
    next = Buffer.from(writeCsv(want.get(sheets[0].name)!, f), 'utf8')
  } else {
    const sheets = readXlsx(buf)
    if (sheets.some((s) => s.truncated)) throw new HttpError(t('表格太大，只读了前面一部分，不能在这里改'))
    want = expected(sheets, body)
    try {
      next = editXlsx(buf, body.sheets)
    } catch (e) {
      throw new HttpError((e as Error).message)
    }
  }

  // 写之前先验：新文件重新解析出来要和预期逐格一样，不一样就不写
  const got =
    kind === 'csv'
      ? [
          {
            name: [...want.keys()][0],
            rows: parseCsv(next.toString('utf8'), csvFormat(next.toString('utf8')).delimiter),
          },
        ]
      : readXlsx(next)
  for (const [name, rows] of want) {
    const diff = gridDiff(got.find((s) => s.name === name)?.rows ?? [], rows)
    if (diff)
      throw new HttpError(
        t('保存后读回来的内容和预期不一样（{sheet} 的 {ref}：「{a}」应为「{b}」），没有写入，原文件没动', {
          sheet: name,
          ref: cellRef(diff.r, diff.c),
          a: diff.a,
          b: diff.b,
        }),
      )
  }

  // P4 管着的文件是只读的：先签出
  const writable = await access(full, constants.W_OK).then(
    () => true,
    () => false,
  )
  if (!writable) {
    const p4 = deps.p4Edit ? await deps.p4Edit(full) : false
    if (p4 && !p4.ok) throw new HttpError(t('p4 edit 失败：{err}', { err: p4.err }), 409)
    if (!p4) throw new HttpError(t('文件是只读的，没有权限写入'), 409)
  }
  await backup(projectId, rel, full)
  // 同目录的临时文件再改名替换：写到一半断电也不会留下半个文件
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.agentpanel-tmp`)
  try {
    await writeFile(tmp, next)
    await rename(tmp, full)
  } catch (e) {
    await rm(tmp, { force: true })
    throw new HttpError(t('写入失败：{err}', { err: (e as Error).message }), 409)
  }
  forgetTable(full)
  return openTable(dir, rel, cfg)
}
