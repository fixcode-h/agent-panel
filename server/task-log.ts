/**
 * 每个对话一份专属日志：和对话文件放在同一个目录（`tasks/projects/<项目>/<对话 id>.log`，聊天在 `tasks/chats/`）。
 *
 * 全局日志（server/log.ts）按启动分文件、所有对话混在一起，而且只记报错；一个对话出了「消息发出去却没了」
 * 这类问题时，要的是这一个对话从头到尾经历了什么：收到哪条消息、走了哪条交付路径、CLI 什么时候启动、
 * 停在等下一句、被谁停掉。这里只记这些关键操作，一行一件事，不记模型输出。
 *
 * 写满 2 MB 时把当前文件改名成 `.log.1`（只留一份旧的），删除对话时一起删掉（见 task-store 的 remove）。
 * 写日志失败不影响执行：吞掉错误。
 */
import { appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { inspect } from 'node:util'

const MAX_BYTES = 2 * 1024 * 1024
/** 一个字段最多写这么长：消息正文只留开头，够认出是哪一条 */
const MAX_FIELD = 200

/** 按对话 id 找日志文件：由任务存储注册（它知道对话在哪个项目目录）；找不到时不写 */
let resolve: (id: string) => string | undefined = () => undefined
/** 每个文件已经写了多少：第一次写时读一次实际大小，之后自己累加，不每行都 stat */
const sizes = new Map<string, number>()

export function setTaskLogPath(fn: (id: string) => string | undefined) {
  resolve = fn
}

/** 这个对话的日志文件路径（没有对应的对话时为空） */
export const taskLogPath = (id: string) => resolve(id) ?? ''

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function field(v: unknown): string {
  if (v instanceof Error) return JSON.stringify(v.message.slice(0, MAX_FIELD))
  const s =
    typeof v === 'string'
      ? v
      : typeof v === 'object' && v !== null
        ? inspect(v, { depth: 2, breakLength: Infinity })
        : String(v)
  const cut = s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s
  // 有空格、换行、引号的用 JSON 包起来，一行一件事，grep 时不会被拆开
  return /[\s"=]/.test(cut) || cut === '' ? JSON.stringify(cut) : cut
}

/**
 * 记一件事：`2026-10-30 09:07:12.123 [事件] 键=值 …`。
 * 事件名用中文短语（「收到消息」「交付」「停止」），键名照代码里的字段写，方便对着代码查
 */
export function taskLog(id: string, event: string, data: Record<string, unknown> = {}) {
  if (!id) return
  let file: string | undefined
  try {
    file = resolve(id)
  } catch {
    return
  }
  if (!file) return
  const parts = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${field(v)}`)
  const line = `${stamp()} [${event}]${parts.length ? ' ' + parts.join(' ') : ''}\n`
  try {
    let size = sizes.get(file)
    if (size === undefined) {
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
    }
    if (size + line.length > MAX_BYTES) {
      try {
        renameSync(file, `${file}.1`)
      } catch {}
      size = 0
    }
    appendFileSync(file, line)
    sizes.set(file, size + Buffer.byteLength(line))
  } catch {
    // 目录还没建（对话刚创建还没落盘）或者写不进去：不影响执行
  }
}

/** 删掉对话时连同日志一起删 */
export function removeTaskLog(file: string) {
  sizes.delete(file)
  for (const f of [file, `${file}.1`])
    try {
      unlinkSync(f)
    } catch {}
}
