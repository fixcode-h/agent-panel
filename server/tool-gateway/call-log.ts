/**
 * 调用记录（CallLog，ADR 0084）：工具网关每次调用记一条。
 * - 内存：每个项目留最近 RING 条（设置「调用记录」页和统计从这里取）；
 * - 磁盘：追加写数据目录 logs/tool-calls/<日期>.jsonl，按天一个文件，只留最近 KEEP_DAYS 天。
 *   一行一件事：工具前那条 `{"t":"call",…记录}`，工具后补一行 `{"t":"done","id",…}`（只追加、不改写已写的行）；
 * - 推送：新记录和补上结果的记录都整条推给打开着的页面（page-events 的 tool-call），页面不轮询。
 * 写盘失败只记日志，不影响工具调用：记录是给人看的，丢了不该让 Agent 停下
 */
import path from 'node:path'
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import type { CallRecord } from '../../shared/tool-gateway/types.ts'
import { DATA_DIR } from '../store.ts'
import { log } from '../log.ts'
import { signalPages } from '../page-events.ts'

const RING = 500
const KEEP_DAYS = 14
const byProject = new Map<string, CallRecord[]>() // 模块状态：运行时，最近的调用记录；重启后从空开始（磁盘上的 jsonl 留着）

const dir = () => path.join(DATA_DIR, 'logs', 'tool-calls')
const day = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let lastDay = '' // 模块状态：运行时，上次写的是哪天的文件（换天时清一次旧文件）
let broken = false // 模块状态：运行时，写不进去后本次运行不再试

async function append(at: number, line: unknown) {
  if (broken) return
  try {
    const d = day(at)
    if (d !== lastDay) {
      await mkdir(dir(), { recursive: true })
      lastDay = d
      await prune()
    }
    await appendFile(path.join(dir(), `${d}.jsonl`), `${JSON.stringify(line)}\n`)
  } catch (e) {
    broken = true
    log.warn('gateway', '调用记录写不进去，本次运行只留内存里的', { error: (e as Error).message })
  }
}

async function prune() {
  const files = (await readdir(dir())).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort()
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS)))
    await unlink(path.join(dir(), f)).catch(() => {})
}

/** 同一轮里上一条记录（找「本可以并行」用） */
export function lastInTurn(projectId: string, turn: string): CallRecord | undefined {
  const list = byProject.get(projectId) ?? []
  for (let i = list.length - 1; i >= 0; i--) if (list[i].turn === turn) return list[i]
  return undefined
}

export function addCall(r: CallRecord) {
  const list = byProject.get(r.projectId) ?? []
  list.push(r)
  if (list.length > RING) list.splice(0, list.length - RING)
  byProject.set(r.projectId, list)
  void append(r.at, { t: 'call', ...r })
  signalPages({ type: 'tool-call', call: r })
}

/** 工具后补上执行结果（记录对象本身已经改过，这里落盘和推送） */
export function callDone(r: CallRecord) {
  void append(Date.now(), {
    t: 'done',
    id: r.id,
    ...(r.durMs !== undefined && { durMs: r.durMs }),
    ...(r.failed !== undefined && { failed: r.failed }),
    ...(r.skills && { skills: r.skills }),
    ...(r.pushes && { pushes: r.pushes }),
  })
  signalPages({ type: 'tool-call', call: r })
}

/** 最近的调用记录，新的在前；不给项目时所有项目合在一起按时间排 */
export function recentCalls(projectId?: string): CallRecord[] {
  const all = projectId !== undefined ? (byProject.get(projectId) ?? []) : [...byProject.values()].flat()
  // 先倒过来再排：同一毫秒里的几条也是后记的在前（sort 是稳定的）
  return [...all].reverse().sort((a, b) => b.at - a.at)
}

/** 测试用：清空内存里的记录 */
export function clearCalls() {
  byProject.clear()
}
