/**
 * 搜索规范检查用的分词：按 shell 的引号规则把一段命令切成词，记下每个词有没有被引号包着。
 * 只为「认参数、拼建议命令」，不追求和 shell 完全一致：认不准的情况由规则自己放过
 */

export interface Word {
  v: string
  quoted: boolean
}

/** 单引号原样；双引号里只认 \" 和 \\；引号外的反斜杠原样保留（Windows 路径） */
export function splitWords(seg: string): Word[] {
  const out: Word[] = []
  let cur = ''
  let quoted = false
  let has = false
  let q = ''
  const push = () => {
    if (has) out.push({ v: cur, quoted })
    cur = ''
    quoted = false
    has = false
  }
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (q) {
      if (c === q) q = ''
      else if (q === '"' && c === '\\' && (seg[i + 1] === '"' || seg[i + 1] === '\\')) cur += seg[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      q = c
      quoted = true
      has = true
      continue
    }
    if (/\s/.test(c)) {
      push()
      continue
    }
    cur += c
    has = true
  }
  push()
  return out
}

/**
 * 拼回命令里的一个参数：只有字母数字和路径符号的原样写，别的用单引号包（bash 和 PowerShell 都按原文读单引号）；
 * 本身带单引号的改用双引号
 */
export function quoteArg(v: string): string {
  // * ? 不在原样写的范围里：不加引号会被 shell 先展开成文件名
  if (/^[\w./:\\@%+=,-]+$/.test(v) && !/^[-]/.test(v)) return v
  if (!v.includes("'")) return `'${v}'`
  return `"${v.replace(/(["\\$`])/g, '\\$1')}"`
}
