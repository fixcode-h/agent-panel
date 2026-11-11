/**
 * 评审差异里的二进制文件换成语义差异（UE 2）：按扩展名认领——表格（.xlsx / .xlsm）面板自己按格子比，
 * 其他扩展名交给开着的插件的文本化接口（ServerPlugin.textify）。两版内容从 git 快照或 p4 的 have 版本取。
 * 没人认领的二进制文件不处理，评审只在文件列表里看到它。拼文字见 shared/review-semantic.ts
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SheetData } from '../../shared/files.ts'
import { semanticSection, workbookDiffText, lineDiffText, type SemanticPart } from '../../shared/review-semantic.ts'
import type { Project } from '../../shared/schema.ts'
import { TableSchema, TablesConfig, tableKind } from '../../shared/tables.ts'
import { textifierFor } from '../plugins/runtime.ts'
import { parseTableBuffer } from '../tables/files.ts'
import { vcsRun } from '../tables/history.ts'
import { readSchema, schemaDir } from '../tables/schema-store.ts'
import { blobAt } from './git.ts'
import { capture } from './process.ts'

/** 一次评审最多整理这么多个二进制文件：一次改几百张表时只看前面的，其余评审按文件列表自己看 */
const MAX_FILES = 30

/** 取一版内容：null 是这一版没有这个文件 */
type Load = (file: string) => Promise<Buffer | null>

const extOf = (file: string) => path.extname(file).slice(1).toLowerCase()

/** 这个文件有没有人认领：表格面板自己比，其他看插件 */
export function claimed(file: string) {
  return tableKind(file) === 'xlsx' || !!textifierFor(extOf(file))
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function sheetsOf(file: string, buf: Buffer | null): Promise<SheetData[] | null> {
  return buf ? (await parseTableBuffer(file, buf)).sheets : null
}

async function partOf(file: string, cwd: string, old: Load, next: Load, schema: TableSchema): Promise<SemanticPart> {
  if (tableKind(file) === 'xlsx') {
    const how = '表格，按格子比较'
    try {
      const [a, b] = await Promise.all([
        old(file).then((x) => sheetsOf(file, x)),
        next(file).then((x) => sheetsOf(file, x)),
      ])
      return { path: file, how, text: workbookDiffText(file, a, b, schema) }
    } catch (e) {
      return { path: file, how, text: '', error: errText(e) }
    }
  }
  const tx = textifierFor(extOf(file))
  if (!tx) return { path: file, how: '', text: '', error: '没有开着的插件认领这个扩展名' }
  const how = `插件 ${tx.id} 转成文本后逐行比较`
  try {
    const conv = async (side: 'old' | 'new', buf: Buffer | null) =>
      buf ? String(await tx.text({ path: file, cwd, side, data: buf })) : ''
    const [a, b] = await Promise.all([old(file), next(file)])
    const [ta, tb] = await Promise.all([conv('old', a), conv('new', b)])
    const text = !a ? `新建的文件：\n${tb}` : !b ? `删掉的文件（原来的内容）：\n${ta}` : lineDiffText(ta, tb)
    return { path: file, how, text }
  } catch (e) {
    return { path: file, how, text: '', error: errText(e) }
  }
}

/** 按认领筛文件、逐个整理，拼成提示词里的一节；一个都没有时返回空串 */
export async function semanticFor(files: string[], cwd: string, old: Load, next: Load, schema: TableSchema) {
  const mine = files.filter(claimed)
  const parts: SemanticPart[] = []
  for (const f of mine.slice(0, MAX_FILES)) parts.push(await partOf(f, cwd, old, next, schema))
  const more = mine.length - parts.length
  const section = semanticSection(parts)
  return section && more > 0 ? `${section}\n\n（还有 ${more} 个二进制文件没整理，按文件列表自己看）` : section
}

/** Git：两棵快照树之间改了的文件（files 给了就只看这些） */
export async function gitSemantic(
  cwd: string,
  from: string,
  to: string,
  files: string[] | undefined,
  schema: TableSchema,
) {
  const scope = files ? ['--', ...files] : ['--', '.']
  const r = await capture(
    'git',
    ['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', from, to, ...scope],
    cwd,
  )
  const changed = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!changed.some(claimed)) return ''
  return semanticFor(
    changed,
    cwd,
    (f) => blobAt(cwd, from, f),
    (f) => blobAt(cwd, to, f),
    schema,
  )
}

/** p4 print 说没有这一版（新加的文件、不在 client 里）：当作改动前没有这个文件 */
const P4_MISSING = /no such file|not on client|not in client view|file\(s\) not/i

/** P4：改动前是工作区的 have 版本（p4 print），改动后是磁盘上的文件 */
export async function p4Semantic(cwd: string, files: string[], schema: TableSchema) {
  if (!files.some(claimed)) return ''
  const old: Load = (f) =>
    vcsRun('p4', ['print', '-q', `${f}#have`], cwd).catch((e: unknown) => {
      if (P4_MISSING.test(errText(e))) return null
      throw e
    })
  const next: Load = (f) => readFile(path.join(cwd, f)).catch(() => null)
  return semanticFor(files, cwd, old, next, schema)
}

/**
 * 项目的表格结构（表头规则、主键）：和表格页的版本差异用同一份，评审看到的行和字段名与表格页一致；
 * 没开表格功能、读不到时按自动识别
 */
export async function reviewTableSchema(p: Pick<Project, 'id' | 'path' | 'tables'>, dir = p.path) {
  if (!p.tables || !dir) return TableSchema.parse({})
  return readSchema(schemaDir(dir, p.id, TablesConfig.parse(p.tables))).catch(() => TableSchema.parse({}))
}
