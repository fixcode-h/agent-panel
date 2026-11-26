/**
 * 项目程序位置的存放（shared/custom-tools/programs.ts）：<数据目录>/program-paths.json，按项目 id 分组
 * （不在项目里的对话记在 '' 下）。路径是这台电脑上的，所以不进项目文档、不进仓库。
 * 读的时候核对文件还在不在：挪走、删掉的标 missing，不再推给 Agent
 */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  programProblem,
  ProgramPath,
  upsertProgram,
  withoutProgram,
  type ProgramPathView,
} from '../../shared/custom-tools/programs.ts'
import { DATA_DIR, writeTextAtomic } from '../store.ts'

export const PROGRAMS_FILE = path.join(DATA_DIR, 'program-paths.json')

const FileShape = z.record(z.string(), z.array(ProgramPath))
type FileShape = z.infer<typeof FileShape>

/** 写入排队：Agent 和设置页同时改时不互相覆盖 */
let queue: Promise<unknown> = Promise.resolve() // 模块状态：写入队列，只为串行化，重启后从空队列开始

async function readAll(): Promise<FileShape> {
  const raw = await readFile(PROGRAMS_FILE, 'utf8').catch(() => '')
  if (!raw.trim()) return {}
  const r = FileShape.safeParse(JSON.parse(raw))
  if (!r.success) throw new Error(`程序位置文件格式不对（${PROGRAMS_FILE}）：${r.error.issues[0]?.message ?? ''}`)
  return r.data
}

function update(fn: (all: FileShape) => FileShape | void) {
  const run = queue.then(async () => {
    const all = await readAll()
    const next = fn(all) ?? all
    await writeTextAtomic(PROGRAMS_FILE, JSON.stringify(next, null, 2) + '\n')
  })
  queue = run.catch(() => undefined)
  return run
}

/** 这个项目登记过的程序（文件不在了的标 missing） */
export async function listPrograms(projectId = ''): Promise<ProgramPathView[]> {
  const list = (await readAll().catch(() => ({}) as FileShape))[projectId] ?? []
  return list.map((p) => (existsSync(p.path) ? p : { ...p, missing: true }))
}

/** 登记或改一条：同名的覆盖。路径要是这台电脑上存在的文件，名字只认程序名 */
export async function setProgram(
  projectId: string,
  input: { name: string; path: string; note?: string; by?: string },
): Promise<{ ok: boolean; info: string }> {
  const name = input.name.trim()
  const file = input.path.trim().replace(/^["']|["']$/g, '')
  const bad = programProblem(name, file) || (path.isAbsolute(file) ? '' : `路径要写完整的绝对路径：${file}`)
  if (bad) return { ok: false, info: bad }
  const s = await stat(file).catch(() => undefined)
  if (!s?.isFile()) return { ok: false, info: `这台电脑上没有这个文件：${file}` }
  const entry = ProgramPath.parse({
    name,
    path: file,
    note: (input.note ?? '').trim().slice(0, 80),
    at: new Date().toISOString(),
    by: input.by ?? '',
  })
  await update((all) => {
    all[projectId] = upsertProgram(all[projectId] ?? [], entry)
  })
  return { ok: true, info: `已登记 ${name}：${file}` }
}

/** 删掉一条；没有这条时 ok 为 false */
export async function removeProgram(projectId: string, name: string): Promise<{ ok: boolean; info: string }> {
  let found = false
  await update((all) => {
    const r = withoutProgram(all[projectId] ?? [], name)
    const rest = r.rest
    found = r.found
    if (rest.length) all[projectId] = rest
    else delete all[projectId]
  })
  return found ? { ok: true, info: `已删掉 ${name} 的登记` } : { ok: false, info: `没有登记过 ${name}` }
}
