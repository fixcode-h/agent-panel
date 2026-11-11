/**
 * 表格的结构文件：表头规则、枚举、列的结构、单文件的表头覆盖。全部存在表格之外——
 * 项目目录 .agentpanel/tables/（能提交给团队）或数据目录 tables/<项目 id>/（只在本机），由项目设置决定。
 * 拆成 4 个文件，多人各改各的部分不容易冲突；JSON 两格缩进，版本控制里看得出改了什么。
 */
import path from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { TableSchema, type TablesConfig } from '../../shared/tables.ts'
import { DATA_DIR } from '../store.ts'

const PARTS = ['style', 'enums', 'columns', 'files'] as const

export function schemaDir(projectDir: string, projectId: string, cfg: Pick<TablesConfig, 'store'>) {
  return cfg.store === 'data'
    ? path.join(DATA_DIR, 'tables', projectId)
    : path.join(projectDir, '.agentpanel', 'tables')
}

export async function readSchema(dir: string): Promise<TableSchema> {
  const raw: Record<string, unknown> = {}
  for (const p of PARTS) {
    const text = await readFile(path.join(dir, `${p}.json`), 'utf8').catch(() => '')
    if (!text) continue
    try {
      const v = JSON.parse(text) as unknown
      // style.json 里还顺带记分析时间
      if (p === 'style' && v && typeof v === 'object' && 'analyzedAt' in v) {
        const { analyzedAt, ...rest } = v as Record<string, unknown>
        raw.analyzedAt = analyzedAt
        raw.style = rest
      } else raw[p] = v
    } catch {
      // 手改坏了的文件当没有，不让整个表格页打不开
    }
  }
  const got = TableSchema.safeParse(raw)
  return got.success ? got.data : TableSchema.parse({})
}

async function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

/** 整份写回；内容没变的部分不写（不让版本控制里出现无意义的改动） */
export async function writeSchema(dir: string, s: TableSchema) {
  const next = TableSchema.parse(s)
  await mkdir(dir, { recursive: true })
  const body: Record<(typeof PARTS)[number], unknown> = {
    style: next.analyzedAt ? { ...next.style, analyzedAt: next.analyzedAt } : next.style,
    enums: next.enums,
    columns: next.columns,
    files: next.files,
  }
  for (const p of PARTS) {
    const file = path.join(dir, `${p}.json`)
    const text = `${JSON.stringify(body[p], null, 2)}\n`
    const old = await readFile(file, 'utf8').catch(() => null)
    if (old === text) continue
    // 空的部分且文件本来就没有：不建空文件
    if (old === null && (text === '{}\n' || text === '[]\n')) continue
    await writeAtomic(file, text)
  }
  return next
}
