/**
 * 按引号切命令：只在引号外的 &&、||、;、|、& 和换行处切，并记下每段前面是哪个连接符。
 *
 * 为什么不用 commandSegments：它不看引号，`rg "A|B"` 会在引号里的 | 处切开；改道要知道搜索段前后怎么连
 * （是不是被管道喂进来、后面有没有再过滤），连接符也得留着。认不准的（反引号、$( )、heredoc、没配对的引号）返回 undefined
 */

export interface ShellPart {
  text: string
  /** 这一段前面的连接符；第一段为空 */
  op: '' | '&&' | '||' | ';' | '|' | '&' | '\n'
  /** 这一段（去掉首尾空白后）在原命令里的起止位置：逐段原地改写时按它换 */
  start: number
  end: number
}

export function splitTop(command: string): ShellPart[] | undefined {
  if (/`|\$\(|<</.test(command)) return undefined
  const parts: ShellPart[] = []
  let cur = ''
  let op: ShellPart['op'] = ''
  let quote = ''
  let from = 0
  const push = (next: ShellPart['op'], at: number, width: number) => {
    const lead = cur.length - cur.trimStart().length
    const text = cur.trim()
    parts.push({ text, op, start: from + lead, end: from + lead + text.length })
    cur = ''
    op = next
    from = at + width
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"') cur += c + (command[++i] ?? '')
      if (c === '\\' && quote === '"') continue
      cur += c
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '\\') {
      cur += c + (command[++i] ?? '')
      continue
    } else if ((c === '&' || c === '|') && command[i + 1] === c) {
      push(c === '&' ? '&&' : '||', i, 2)
      i++
      continue
    } else if (c === '>' && command[i + 1] === '&') {
      // 2>&1 这类重定向不是连接符
      cur += '>&'
      i++
      continue
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      push(c, i, 1)
      continue
    }
    cur += c
  }
  if (quote) return undefined
  push('', command.length, 0)
  return parts.filter((p) => p.text)
}
