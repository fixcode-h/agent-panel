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
