/**
 * 面板自己取日志（分析稿 B3）：报告里写了日志文件在哪时，用户不用自己打开文件复制粘贴——
 * 点「开始复现」面板记下文件现在多大，点「复现完了，取日志」面板算出复现期间新增的内容从第几行开始，
 * 把日志文件作为文件引用放进输入框、写明从第几行往后看（用户 2026-11-13 要的：不再把内容截出来粘贴，
 * 日志一长输入框和提示词都塞不下，Agent 自己按行号去读更准）。
 * 这里只放纯函数（从「日志在哪」那句话里认出文件路径、数行、筛相关行、解码）；读文件和路径范围的检查在
 * server/tasks/bug-log-watch.ts
 */
import { TEMP_LOG } from './cleanup.ts'

/** 数「带 [排查- 的行」最多看新增内容的这么多字节：再多只数前面这段并说明 */
export const MAX_NEW_BYTES = 2 * 1024 * 1024

/** 常见的日志文件后缀：没写目录、只写了文件名（app.log）时靠它认 */
const LOG_EXT = /\.(log|txt|out|err|jsonl?|ndjson|csv|trace)$/i
const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/
/** 一句话里把路径隔开的字符：空白、中文和全角标点、引号括号 */
const SPLIT = /[\s　-〿一-鿿＀-￯"'`<>()[\]{}|]+/

export const isAbsPath = (p: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(p)

const tidy = (s: string) =>
  s
    .trim()
    .replace(/^[,;:=]+/, '')
    .replace(/[,;:.!?]+$/, '')

const looksLikeFile = (s: string) =>
  !!s &&
  !s.includes('://') &&
  !s.startsWith('[') &&
  (LOG_EXT.test(s) || ((s.includes('/') || s.includes('\\')) && HAS_EXT.test(s)))

/**
 * 从「日志在哪」那句话（collect.where）里认出文件路径，按出现顺序去重。
 * 反引号、引号括起来的整段先认（路径里有空格、中文目录时 Agent 一般会这么写），其余按空白和中文断开一段一段看。
 * 「控制台」「浏览器开发者工具」「http://…」这类不是文件的认不出来，返回空——面板就不出「开始复现」
 */
export function logPathsIn(where: string | undefined): string[] {
  if (!where?.trim()) return []
  const out: string[] = []
  const add = (s: string) => {
    const p = tidy(s)
    if (looksLikeFile(p) && !out.includes(p)) out.push(p)
  }
  let rest = where
  for (const m of where.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|「([^」\n]+)」/g)) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (looksLikeFile(tidy(inner))) {
      add(inner)
      rest = rest.replace(m[0], ' ')
    }
  }
  for (const part of rest.split(SPLIT)) add(part)
  return out
}

/** 报告里写的那个日志文件（第一个认出来的）；没写文件返回空串 */
export const logPathIn = (where: string | undefined) => logPathsIn(where)[0] ?? ''

/** 用户交的日志开头是一个本机日志文件路径（面板取日志时引用的文件、或者只贴了路径） */
const FILE_LEAD =
  /^@?["'`]?((?:[A-Za-z]:[\\/]|\/|~[\\/])[^"'`\n]+?\.(?:log|txt|out|err|jsonl?|ndjson|csv|trace))["'`]?(.*)$/s

/** 拆出开头的日志文件路径和后面的话；开头不是路径返回 undefined */
export function fileLead(text: string): { path: string; rest: string } | undefined {
  const m = FILE_LEAD.exec(text.trim())
  return m ? { path: m[1], rest: m[2].trim() } : undefined
}

/**
 * 用户贴的日志正文：开头是日志文件路径、后面只有一行说明（「从第 N 行往后看」）的不算正文——
 * 日志在那个文件里，数命中、按行号引用都要去读文件，不能拿这句话当日志
 */
export function pastedLog(logs: string): string {
  const lead = fileLead(logs)
  return lead && !lead.rest.includes('\n') ? '' : logs.trim()
}

/** 新增内容里和这次排查有关的行：带 `[排查-` 前缀的（Agent 加的临时日志都以它开头） */
export function relatedLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.includes(TEMP_LOG))
    .join('\n')
}

/**
 * 该读文件的哪一段：从记下的大小读到现在的末尾。
 * 文件比记下的时候还小（日志被清空、轮转成了新文件）：整个文件都算新增（rotated）。
 * 超过上限只取前面那一段（truncated），后面的截掉
 */
export function newRange(marked: number, now: number, max = MAX_NEW_BYTES) {
  const rotated = now < marked
  const from = rotated ? 0 : marked
  const total = now - from
  return { from, length: Math.min(total, max), total, truncated: total > max, rotated }
}

/** 是不是 UTF-16（Windows 上有些程序的日志）：有 BOM，或者前几百个字节里隔一个就是 0 */
export function looksUtf16(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 400)
  let zeros = 0
  for (let i = 1; i < head.length; i += 2) if (head[i] === 0) zeros++
  return (head[0] === 0xff && head[1] === 0xfe) || (head.length >= 8 && zeros > head.length / 4)
}

/**
 * 一段字节里换行符的位置（相对这段开头）。utf16 时只认偶数位上的 0A 00，免得把「上」(4E0A) 这类字的低字节当成换行；
 * 分段读文件时每段从偶数位开始，奇偶就不会错
 */
export function newlineOffsets(bytes: Uint8Array, utf16: boolean): number[] {
  const out: number[] = []
  for (let i = bytes.indexOf(10); i >= 0; i = bytes.indexOf(10, i + 1)) {
    if (utf16 && (i % 2 !== 0 || bytes[i + 1] !== 0)) continue
    out.push(i)
  }
  return out
}

/**
 * 新增内容在文件里是第几行到第几行（从 1 数）。before 是起点之前的换行数，total 是整个文件的换行数，
 * endsWithNewline 是文件最后一个字符是不是换行。起点正好在一行中间时从这一行算起（新内容接在它后面）
 */
export function lineSpan(s: { before: number; total: number; endsWithNewline: boolean; size: number }) {
  const end = s.size === 0 ? 0 : s.endsWithNewline ? s.total : s.total + 1
  return { startLine: s.before + 1, endLine: end }
}

/**
 * 解出来的文字收拾一下：开头的 BOM 去掉、换行统一；被截断的（cut）丢掉最后半行，免得交出去半个字符、半行日志
 */
export function tidyLog(raw: string, cut = false): string {
  // 先统一换行再截：\r\n 的文件截完会剩一个 \r 被换成多出来的空行
  let text = raw.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n')
  if (cut) {
    const end = text.lastIndexOf('\n')
    if (end >= 0) text = text.slice(0, end)
  }
  return text
}

/**
 * 取回来的结果：不带日志内容，只说文件在哪、新增的从第几行开始。abs 是本机绝对路径（放进输入框当文件引用），
 * startLine / endLine 是新增内容的起止行号，related 是新增里带 [排查- 的行数，其余是给用户的说明
 */
export type LogFetch = {
  path: string
  abs: string
  /** 文件现在多大（字节） */
  size: number
  startLine: number
  endLine: number
  /** 新增了多少字节 */
  bytes: number
  related: number
  /** 新增内容太大，related 只数了前 MAX_NEW_BYTES */
  truncated: boolean
  rotated: boolean
}

/** 拒绝：error 是给用户看的说明；needConfirm 表示文件在项目目录外面，用户点了确认再发一次就读 */
export type LogRefuse = { ok: false; error: string; needConfirm?: boolean; path?: string }
/** 开始复现：missing 是文件现在还不存在（复现时才生成），outside 是读的项目目录外面的文件 */
export type LogStartResult = { ok: true; path: string; size: number; missing: boolean; outside: boolean } | LogRefuse
export type LogFetchResult = ({ ok: true } & LogFetch) | LogRefuse
/** 之前点过「开始复现」：页面重开后接着显示「复现完了，取日志」 */
export type LogWatchStatus = { started?: { path: string; at: string } }
