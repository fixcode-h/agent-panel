import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import type { TaskMessage } from '../../shared/schema.ts'
import { log } from '../log.ts'
import { DATA_DIR, writeTextAtomic } from '../store.ts'
import { MSG_JSONL, MSG_LEGACY, appendMessageLines, messagesToJsonl } from './messages-file.ts'

/**
 * 对话文件怎么写：追加还是整份压实（ADR 0060）。从 server/task-store.ts 的 createTaskStore 拆出来，
 * 盘上状态由调用方拿着、显式传进来，这里不留任何模块级状态。
 */

/**
 * 一个对话的对话文件现在在盘上是什么样：整体指纹（没变就不写）、逐条 id 和指纹（决定追加哪几行）、
 * 文件字节数和其中覆盖记录的字节数（决定什么时候压实）、是不是以换行结尾
 */
export type MessagesFileState = {
  key: string
  ids: string[]
  stamps: string[]
  bytes: number
  extra: number
  cleanEnd: boolean
}

/**
 * 覆盖记录（同 id 的新版本）攒到多少字节就整份压实一次：至少这么多，并且不少于有效内容本身。
 * 流式输出时最后一条消息一直在变，每个窗口追加一份它的新版本；压实就是旧的整份原子重写，只是少很多次
 */
const COMPACT_MIN = 2 * 1024 * 1024
/** 关键节点（一轮结束、提问、停止）立即写时，覆盖记录超过有效内容的一半就顺手压实 */
const COMPACT_AT_KEY = 0.5

export type WriteInput = {
  /** 对话文件去掉后缀的路径 */
  base: string
  msgs: TaskMessage[]
  /** 这次的整体指纹和逐条 id、指纹（createStampTracker 的 stamp / detail） */
  key: string
  cur: { ids: string[]; stamps: string[] }
  /** 盘上现在的样子；不知道（刚启动没读过、被挤出内存、读到坏行）时为 undefined，整份重写 */
  prev: MessagesFileState | undefined
  /** 关键节点立即写 */
  atKey: boolean
}

/**
 * 写一次对话文件，返回写完后盘上的样子。
 * 盘上的是这次的前缀（只多了消息、或有几条原地改过）就只追加变了的那几行；
 * 删过、换过顺序（返工、回退）或者覆盖记录攒多了，就整份原子重写（压实）。
 * 追加失败时抛出 { appendFailed: true }：盘上可能多了半行，调用方要丢掉状态、下一次整份重写
 */
export async function writeMessagesFile(w: WriteInput): Promise<MessagesFileState> {
  const { prev, cur, msgs } = w
  const snap = (bytes: number, extra: number): MessagesFileState => ({
    key: w.key,
    ids: [...cur.ids],
    stamps: [...cur.stamps],
    bytes,
    extra,
    cleanEnd: true,
  })
  if (prev && cur.ids.length >= prev.ids.length && prev.ids.every((id, i) => cur.ids[i] === id)) {
    let text = ''
    let extra = 0
    for (let i = 0; i < cur.ids.length; i++) {
      if (i < prev.ids.length && cur.stamps[i] === prev.stamps[i]) continue
      const line = JSON.stringify(msgs[i]) + '\n'
      text += line
      if (i < prev.ids.length) extra += Buffer.byteLength(line)
    }
    const total = prev.extra + extra
    const live = prev.bytes - prev.extra
    const compact = total > Math.max(COMPACT_MIN, live) || (w.atKey && total > 0 && total > live * COMPACT_AT_KEY)
    if (!compact) {
      if (!prev.cleanEnd) text = '\n' + text
      try {
        await appendMessageLines(w.base + MSG_JSONL, text)
      } catch (e) {
        throw Object.assign(e as Error, { appendFailed: true })
      }
      return snap(prev.bytes + Buffer.byteLength(text), total)
    }
  }
  const text = messagesToJsonl(msgs)
  await writeTextAtomic(w.base + MSG_JSONL, text)
  // 还留着上一版的整份 `.messages.json`（迁移没转完、导入了旧备份）：JSONL 已经写全了，旧文件挪走
  await retireLegacyMessages(w.base)
  return snap(Buffer.byteLength(text), 0)
}

/** 上一版的整份 `.messages.json`：挪进和迁移 0003 同一个备份目录、同样的相对路径（不直接删，万一要退回旧版本） */
export async function retireLegacyMessages(base: string) {
  const old = base + MSG_LEGACY
  if (!existsSync(old)) return
  const dest = path.join(DATA_DIR, 'backup', '0003-messages-jsonl', path.relative(DATA_DIR, old))
  await mkdir(path.dirname(dest), { recursive: true }).catch(() => {})
  await rename(old, dest).catch((e) => log.warn('task', '旧的对话文件没能挪走', { file: old, error: String(e) }))
}

/**
 * 读到的对话文件记成「盘上现在的样子」，之后才能接着追加。
 * 读的是旧格式、或读到坏行时返回 undefined：下一次整份重写
 */
export function stateFromRead(
  key: string,
  cur: { ids: string[]; stamps: string[] },
  count: number,
  r: { bytes: number; lines: number; bad: number; cleanEnd: boolean; legacy: boolean },
): MessagesFileState | undefined {
  if (r.legacy || r.bad) return undefined
  // 覆盖记录有多少字节读的时候不细算：按多出来的行数估个比例，只影响下次什么时候压实
  const extra = r.lines > count ? Math.round((r.bytes * (r.lines - count)) / r.lines) : 0
  return { key, ids: [...cur.ids], stamps: [...cur.stamps], bytes: r.bytes, extra, cleanEnd: r.cleanEnd }
}
