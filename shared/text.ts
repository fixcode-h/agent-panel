/**
 * 文本截断：提示词、导出报告、界面摘要都要把长文本压到固定长度。
 * 各处历史写法略有差异（折行、总长口径、带省略字数的后缀、保留头尾），
 * 统一收在这一处，差异用 ClipOptions 表达；默认等于最常用的「截到 n 个字再补一个 …」。
 */

/** 省略标记：参数是被省略的字数，需要写明「省略了多少字」的文案在这里拼 */
export type ClipMark = (omitted: number) => string

export interface ClipOptions {
  /** 先把换行和连续空白折成一个空格、去掉首尾空白，再判断长度（提示词里不放长段落） */
  oneLine?: boolean
  /** n 是含省略标记的总长：截断时留一位给标记，保证结果不超过 n */
  total?: boolean
  /** 省略标记，默认 '…' */
  mark?: ClipMark
  /** 保留结尾的比例（0–1）：只留头尾、省略中间，n 是头尾加起来的总长 */
  tailRatio?: number
}

const ELLIPSIS = '…'

export function clip(text: string, n: number, opts: ClipOptions = {}): string {
  const s = opts.oneLine ? text.replace(/\s+/g, ' ').trim() : text
  if (s.length <= n) return s
  const mark = opts.mark ?? (() => ELLIPSIS)
  if (opts.tailRatio !== undefined) {
    // 头和尾按比例分 n 个字的额度，中间那截用 mark 说明省略了多少
    const head = s.slice(0, n * opts.tailRatio)
    const tail = s.slice(-n * (1 - opts.tailRatio))
    return head + mark(s.length - head.length - tail.length) + tail
  }
  const keep = opts.total ? n - 1 : n
  return s.slice(0, keep) + mark(s.length - keep)
}
