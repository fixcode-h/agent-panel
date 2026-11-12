import { copyFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { TaskMessage } from '../shared/schema.ts'
import { BROKEN_DIR } from './store.ts'

/**
 * 对话消息文件：追加写的 JSONL（重构文档第 7 条）。
 *
 *   <任务 id>.messages.jsonl   一行一条消息（完整的 TaskMessage）
 *
 * 为什么不再整份重写 `.messages.json`：长对话的文件有几 MB，流式输出时每个合并窗口都要把整份数组
 * 序列化、写盘一遍，十几个子对话同时跑时事件循环被读写 JSON 占满。现在新消息追加一行；
 * 工具行这类原地更新的消息，追加一条同 id 的新版本，读的时候按 id 归并（后出现的盖掉前面的，位置不变）。
 * 覆盖记录攒多了（见 task-store 的压实规则）才整份原子重写一次。
 *
 * 崩溃时最后一行可能只写了一半：读的时候丢掉坏行，不让整个对话读不出来。
 */
export const MSG_JSONL = '.messages.jsonl'
/** 上一版的整份 JSON 数组文件：迁移（server/migrations/0003）把它转成 JSONL，转换没做完时读它兜底 */
export const MSG_LEGACY = '.messages.json'

export type ParsedMessages = {
  messages: TaskMessage[]
  /** 非空行数（含坏行、覆盖记录） */
  lines: number
  /** 读不懂的行数（JSON 坏了或过不了 schema） */
  bad: number
  /** 坏行是不是只有最后那半行（崩溃时正在写）：是的话不算文件坏了 */
  badOnlyTail: boolean
  /** 文件是否以换行结尾：不是的话下次追加前先补一个换行，免得新行接在半行后面 */
  cleanEnd: boolean
}

/** 按 id 归并：同 id 后出现的盖掉前面的，位置按第一次出现的算 */
export function parseMessagesJsonl(text: string): ParsedMessages {
  const out: TaskMessage[] = []
  const at = new Map<string, number>()
  let lines = 0
  let bad = 0
  let lastBad = false
  const rows = text.split('\n')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].trim()
    if (!row) continue
    lines++
    let value: unknown
    try {
      value = JSON.parse(row)
    } catch {
      bad++
      lastBad = i === rows.length - 1
      continue
    }
    const p = TaskMessage.safeParse(value)
    if (!p.success) {
      bad++
      lastBad = false
      continue
    }
    lastBad = false
    const m = p.data
    const idx = at.get(m.id)
    if (idx === undefined) {
      at.set(m.id, out.length)
      out.push(m)
    } else out[idx] = m
  }
  return { messages: out, lines, bad, badOnlyTail: bad === 1 && lastBad, cleanEnd: !text || text.endsWith('\n') }
}

/** 整份写出时的内容：一行一条，以换行结尾 */
export function messagesToJsonl(msgs: TaskMessage[]): string {
  if (!msgs.length) return ''
  let s = ''
  for (const m of msgs) s += JSON.stringify(m) + '\n'
  return s
}

export type ReadMessagesResult =
  | { state: 'missing' }
  | ({ state: 'ok'; bytes: number; legacy: boolean } & ParsedMessages)
  /** 文件在、但一条消息都读不出来（全 0 的空洞文件、内容根本不是对话） */
  | { state: 'broken'; bytes: number; legacy: boolean; reason: string }

/**
 * 读一个任务的对话：先读 JSONL，没有时读上一版的 `.messages.json`（迁移没跑完、导入了旧备份）。
 * 读不出来的错误（权限、文件被占用）照样抛给调用方。
 */
export async function readMessagesFile(base: string): Promise<ReadMessagesResult> {
  const jsonl = await readFile(base + MSG_JSONL).catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return null
    throw e
  })
  if (jsonl) {
    const text = jsonl.toString('utf8')
    const parsed = parseMessagesJsonl(text)
    if (!parsed.messages.length && parsed.lines > 0)
      return { state: 'broken', bytes: jsonl.length, legacy: false, reason: '对话文件里一条消息都读不出来' }
    // 中间有坏行（不只是最后那半行）：先把原文件复制一份留档再说，之后的整份重写会把坏行丢掉
    if (parsed.bad && !parsed.badOnlyTail) await keepBadCopy(base + MSG_JSONL, parsed.bad)
    return { state: 'ok', bytes: jsonl.length, legacy: false, ...parsed }
  }
  const old = await readFile(base + MSG_LEGACY).catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return null
    throw e
  })
  if (!old) return { state: 'missing' }
  let value: unknown
  try {
    value = JSON.parse(old.toString('utf8'))
  } catch (e) {
    return { state: 'broken', bytes: old.length, legacy: true, reason: String((e as Error)?.message ?? e) }
  }
  const p = TaskMessage.array().safeParse(value)
  if (!p.success) return { state: 'broken', bytes: old.length, legacy: true, reason: '对话内容不是一个消息数组' }
  return {
    state: 'ok',
    bytes: old.length,
    legacy: true,
    messages: p.data,
    lines: p.data.length,
    bad: 0,
    badOnlyTail: false,
    cleanEnd: true,
  }
}

/** 对话文件当前的大小（先 JSONL，再旧格式）；都没有时为 null */
export async function statMessagesFile(base: string) {
  return (await stat(base + MSG_JSONL).catch(() => null)) ?? (await stat(base + MSG_LEGACY).catch(() => null))
}

async function keepBadCopy(file: string, bad: number) {
  try {
    await mkdir(BROKEN_DIR, { recursive: true })
    const backup = path.join(BROKEN_DIR, `${path.basename(file)}.badlines-${Date.now()}`)
    await copyFile(file, backup)
    console.error(`对话文件里有 ${bad} 行读不懂，已跳过这些行，原文件复制留档为 ${backup}`)
  } catch (e) {
    console.error(`对话文件里有 ${bad} 行读不懂，已跳过这些行（没能复制留档：${String(e)}）`)
  }
}

/**
 * 往对话文件末尾追加几行并刷盘。fsync 不能省：追加的那几行没落盘就断电，读回来是旧内容或半行，
 * 半行能被读的时候丢掉，但「以为写了其实没写」的那几条就真丢了
 */
export async function appendMessageLines(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const fh = await open(file, 'a')
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } finally {
    await fh.close().catch(() => {})
  }
}
