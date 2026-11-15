import type { ErrorPrint } from '../../schema.ts'
import { wordsOf } from './normalize.ts'

/**
 * 报错指纹（设计稿 4.4.2）：错误码 + 抹掉路径、数字、时间后的词。录入教训时面板用这次真实的报错算好存进
 * ProjectLesson.triggers.errors，运行时工具失败的输出也按同样的规则算，再比两份指纹像不像（printScore）
 */

/** 报错只看前这么多字（命令输出可能很长） */
const HEAD = 4000

const ERROR_LINE = /error|err!|failed|fatal|exception|denied|unauthorized|not found|cannot|错误|失败|找不到|无法/i
const CODE_RE =
  /\b(E[A-Z]{3,}|TS\d{4}|[CE]\d{4}|LNK\d{4}|MSB\d{4}|CS\d{4}|[A-Z][A-Za-z]+(?:Error|Exception)|HTTP\s?[45]\d\d|\b[45]\d\d\s+(?:Unauthorized|Forbidden|Not Found))\b/g
/** 太泛的错误名：只当普通词，不当错误码 */
// 模块状态：常量，加载后不改
const GENERIC_CODE = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'Exception'])

/** 从失败输出里取报错特征：挑含报错字样的行（最多 5 行），没有就取最后 5 个非空行 */
export function errorPrint(output: string): ErrorPrint {
  const head = output.slice(0, HEAD)
  const lines = head.split('\n').map((x) => x.trim())
  const nonEmpty = lines.filter(Boolean)
  let pick = nonEmpty.filter((x) => ERROR_LINE.test(x)).slice(0, 5)
  if (!pick.length) pick = nonEmpty.slice(-5)
  const text = pick
    .join('\n')
    // 绝对路径只留文件名，十六进制、UUID、时间戳、数字都是会变的
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"()]+[\\/]([^\s\\/:'"()]+)/g, ' $1 ')
    .replace(/\b[0-9a-f]{8,}\b/gi, ' ')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, ' ')
  const codes = [...new Set([...text.matchAll(CODE_RE)].map((m) => m[1].replace(/\s+/g, ' ')))].filter(
    (c) => !GENERIC_CODE.has(c),
  )
  const words = wordsOf(text.replace(/\d+/g, ' '))
    .filter((w) => /[一-鿿]/.test(w) || w.length >= 3)
    .slice(0, 20)
  const sample = (pick[0] ?? '').replace(/\s+/g, ' ').slice(0, 200)
  return { codes, words, sample }
}

/**
 * 两份指纹像不像：错误码有交集 +5；词的 Jaccard ≥ 0.5 时加 8 × J。合计 ≥ 5 才算同一个报错，返回 0 表示不像。
 * 错误码对上、词却一个都不沾边的不算（同一个码在别的工具上出现）
 */
export function printScore(a: Pick<ErrorPrint, 'codes' | 'words'>, b: Pick<ErrorPrint, 'codes' | 'words'>): number {
  const code = a.codes.some((c) => b.codes.includes(c)) ? 5 : 0
  const bw = new Set(b.words)
  const inter = a.words.filter((w) => bw.has(w)).length
  const union = new Set([...a.words, ...b.words]).size
  const j = union ? inter / union : 0
  if (code && !inter) return 0
  const score = code + (j >= 0.5 ? 8 * j : 0)
  return score >= 5 ? Number(score.toFixed(2)) : 0
}

/** 指纹的键：同一个报错在不同对话里对得上（候选按它合并、回放按它数复发） */
export const printKey = (p: Pick<ErrorPrint, 'codes' | 'words'>) => [...p.codes, ...p.words.slice(0, 6)].join(' ')
