import { existsSync } from 'node:fs'
import { readdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { Task } from '../../shared/schema.ts'
import { readJson, writeJsonAtomic, writeTextAtomic } from '../store.ts'
import { head, safeTaskId } from '../task-store.ts'
import { MSG_JSONL, messagesToJsonl } from '../task-messages-file.ts'
import type { Migration } from './index.ts'

/**
 * 早期版本没有 turnSeenAt：那时的已完成对话都算看过，否则升级后旧会话会全部亮成未读，还会一直留着 CLI 进程。
 * raw 是原始记录（判断有没有这个键），t 是解析后的
 */
export function fillTurnSeen(raw: unknown, t: { turnSeenAt?: string; turnDoneAt?: string }) {
  if (!raw || typeof raw !== 'object' || Object.prototype.hasOwnProperty.call(raw, 'turnSeenAt')) return false
  t.turnSeenAt = t.turnDoneAt ?? ''
  return true
}

/** 任务文件放在哪个目录：和 server/task-store.ts 的 taskDirOf 一样，只是按传入的数据目录算 */
export const taskDirIn = (root: string, projectId: string) =>
  projectId && safeTaskId(projectId) ? path.join(root, 'projects', projectId) : path.join(root, 'chats')

/** 数据目录里所有放任务文件的目录（chats 和每个项目一个） */
export async function taskDirsIn(root: string) {
  const dirs = [path.join(root, 'chats')]
  const projects = path.join(root, 'projects')
  for (const d of await readdir(projects, { withFileTypes: true }).catch(() => []))
    if (d.isDirectory()) dirs.push(path.join(projects, d.name))
  return dirs.filter((d) => existsSync(d))
}

/**
 * 两代旧的任务存储布局拆成现在的「按项目分目录、每个任务一个记录文件 + 一个对话文件」：
 * - 更早：所有任务在 tasks/tasks.json 一个文件里
 * - 上一版：tasks/items/<id>.json，每个任务一个完整文件，不分项目
 * 原文件挪进备份目录。原来在 server/task-store.ts 里每次启动都检查一遍，现在只跑一次
 */
export const taskLayout: Migration = {
  version: 1,
  name: 'task-layout',
  async run(ctx) {
    const root = path.join(ctx.dataDir, 'tasks')
    const legacy = path.join(root, 'tasks.json')
    const items = path.join(root, 'items')
    const olds: Task[] = []
    const take = (raw: unknown) => {
      const p = Task.safeParse(raw)
      if (!p.success || !safeTaskId(p.data.id)) return
      fillTurnSeen(raw, p.data)
      olds.push(p.data)
    }
    if (existsSync(legacy)) {
      const raw = await readJson(legacy)
      for (const r of Array.isArray(raw) ? raw : []) take(r)
    }
    const itemFiles = existsSync(items) ? (await readdir(items)).filter((f) => f.endsWith('.json')) : []
    for (const f of itemFiles) take(await readJson(path.join(items, f)))
    // 拆文件时对话一起写到对话文件里，不能只留任务本身。路径按 ctx.dataDir 算（测试用临时目录）
    for (const t of olds) {
      const dir = taskDirIn(root, t.projectId)
      await writeJsonAtomic(path.join(dir, `${t.id}.json`), head(t))
      await writeTextAtomic(path.join(dir, `${t.id}${MSG_JSONL}`), messagesToJsonl(t.messages))
    }
    if (existsSync(legacy)) await ctx.moveToBackup(legacy)
    for (const f of itemFiles) await ctx.moveToBackup(path.join(items, f))
    await rmdir(items).catch(() => {})
    if (olds.length) ctx.log(`旧格式的 ${olds.length} 个任务拆成了按项目分目录的文件`)
  },
}
