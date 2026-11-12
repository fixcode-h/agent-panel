/**
 * 对话内容搜索的口径：一次扫多少个对话、一条片段截多长、最多回多少条。
 *
 * 服务端按这些预算扫消息（server/tasks.ts 的 `GET /tasks/search`），前端只负责把片段里命中的词高亮，
 * 两边都不各写一套上限。这里只有纯函数，前端也能 import。
 */

/** 一次搜索最多扫多少个对话（按最近活动倒序，凑够命中就提前停） */
export const SEARCH_TASK_BUDGET = 60
/** 一次搜索最多返回多少条命中（侧栏和命令面板都放得下） */
export const SEARCH_HIT_LIMIT = 20
/** 片段以命中词为中心，两侧各留这么多字 */
export const SNIPPET_PAD = 36
/** 一条片段最长这么多字（两侧 pad 之外再兜一层，防止超长行把界面撑开） */
export const SNIPPET_MAX = 120
/** 一次搜索最多读进多少字符的对话：几 MB 的长对话也不能把首屏拖住，超了就停 */
export const SEARCH_CHAR_BUDGET = 4_000_000
/** 同一个对话最多给几条命中：一个很长的对话不该霸占整个结果列表 */
export const SEARCH_HITS_PER_TASK = 3

/** 一条命中：只有片段和定位信息，不带整条消息 */
export interface SearchHit {
  taskId: string
  title: string
  /** 命中的那条消息，前端打开对话后按它定位 */
  messageId: string
  role: string
  at: string
  /** 这条消息里命中了几次（一条消息只回一段片段） */
  count: number
  /** 命中位置前后的一段原文 */
  snippet: string
  /** 搜索词在片段里的位置（原文里的大小写可能和输入不同，高亮按这个位置截） */
  index: number
  /** 搜索词在片段里的长度 */
  length: number
}

/** 把正文压成一行再搜：换行会把片段切断，用户看到的应该是一句话 */
export function flatText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 一条消息的命中情况：命中几次、片段从哪截。没有命中返回 null。
 * 片段以第一个命中词为中心，两侧各留 SNIPPET_PAD 个字，被截断的一侧补「…」；
 * index 是命中词在片段里的位置（前面补了省略号时要跟着偏移），前端按它高亮。
 */
export function messageHit(text: string, query: string): { count: number; snippet: string; index: number } | null {
  const flat = flatText(text)
  const needle = flatText(query)
  if (!needle || !flat) return null
  const lower = flat.toLowerCase()
  const target = needle.toLowerCase()
  const at = lower.indexOf(target)
  if (at < 0) return null
  // 一条消息里出现几次：片段只截一处，次数用来提示「还有 N 处」
  let count = 0
  for (let i = at; i >= 0; i = lower.indexOf(target, i + target.length)) count++
  const start = Math.max(0, at - SNIPPET_PAD)
  const end = Math.min(flat.length, Math.max(at + target.length, start + SNIPPET_MAX))
  const head = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''
  return {
    count,
    snippet: head + flat.slice(start, end) + tail,
    index: head.length + (at - start),
  }
}

/** messageChars 用到的字段（TaskMessage 的子集） */
interface CountedMessage {
  text: string
  thinking?: string | null
  prompt?: string | null
  tools: { label: string; input?: string | null; output?: string | null }[]
}

/** 一个任务的对话大概多大：只累加字符串长度，不序列化，执行中每次落盘都算一遍也不贵 */
export function messageChars(msgs: CountedMessage[]) {
  let n = 0
  for (const m of msgs) {
    n += m.text.length + (m.thinking?.length ?? 0) + (m.prompt?.length ?? 0)
    for (const t of m.tools) n += t.label.length + (t.input?.length ?? 0) + (t.output?.length ?? 0)
  }
  return n
}

/** searchTasks 要的对话：只用到这几项，消息由调用方按需读（服务端从文件读、有缓存，演示后端直接给内存里的） */
interface Searchable {
  id: string
  title: string
  updatedAt: string
  deletedAt?: string | null
}
interface SearchMessage extends CountedMessage {
  id: string
  role: string
  at: string
}

/**
 * 对话内容搜索（GET /tasks/search）：正式后端和演示后端都调这一份（重构文档第 10 条）。
 * 按最近活动倒序扫，三个预算任一用完就停：扫多少个对话、回多少条、读进来的字数；进了回收站的不参与。
 * load 返回这个对话的消息（服务端从文件读、带缓存，演示后端直接给内存里的）
 */
export async function searchTasks<T extends Searchable>(
  all: T[],
  query: string,
  load: (tk: T) => Promise<SearchMessage[]>,
  asked?: number,
): Promise<{ hits: SearchHit[]; scanned: number; more: boolean }> {
  const q = query.trim()
  if (!q) return { hits: [], scanned: 0, more: false }
  const limit = asked && Number.isFinite(asked) && asked > 0 ? Math.min(SEARCH_HIT_LIMIT, asked) : SEARCH_HIT_LIMIT
  // 最近活动过的先扫：用户要找的多半是刚聊过的那几条
  const list = all.filter((t) => !t.deletedAt).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  const tasks = list.slice(0, SEARCH_TASK_BUDGET)
  const hits: SearchHit[] = []
  let more = list.length > tasks.length
  let searchChars = 0
  for (const tk of tasks) {
    // 结果格子满了就不再读文件：边输边搜，首屏要快
    if (hits.length >= limit) {
      more = true
      break
    }
    const messages = await load(tk)
    if (!messages.length) continue
    const chars = messageChars(messages)
    if (searchChars + chars > SEARCH_CHAR_BUDGET) {
      more = true
      break
    }
    searchChars += chars
    let taken = 0
    for (const m of messages) {
      if (taken >= SEARCH_HITS_PER_TASK) {
        more = true
        break
      }
      const hit = messageHit(m.text, q)
      if (!hit) continue
      if (hits.length >= limit) {
        more = true
        break
      }
      hits.push({
        taskId: tk.id,
        title: tk.title,
        messageId: m.id,
        role: m.role,
        at: m.at,
        count: hit.count,
        snippet: hit.snippet,
        index: hit.index,
        length: q.length,
      })
      taken++
    }
  }
  return { hits, scanned: tasks.length, more }
}
