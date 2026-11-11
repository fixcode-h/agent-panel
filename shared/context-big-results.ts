import type { TaskMessage } from './schema.ts'
import { tokensOfChars } from './context-breakdown.ts'

/**
 * 会话栏「上下文」里的「最大的工具结果」（工作包 I）：细分里工具结果都算在「消息」一项，用户看不出是谁在占。
 * 面板本来就存着每条工具调用的输出，这里从最近一次压缩之后（之前的已经被压成摘要）、当前答话的角色的消息里
 * 挑出最大的几条，按字数估 token。只是估计：CLI 自己可能截过（Claude Code 命令输出 3 万字），存盘的输出也截过
 */

export interface BigResult {
  /** 消息 id 和第几个工具：界面上用来定位 */
  msg: string
  i: number
  /** 动作名（读取、运行……）和对象（文件、命令） */
  name: string
  label: string
  kind: string
  chars: number
  tokens: number
}

/** 存盘时截掉的那截写在结尾：「…（还有 N 个字符没有显示）」（server/exec/parsers.ts 的 clipDetail，中英文都认） */
const OMITTED = /\n…[^\n]*?(\d+)[^\n]*$/

/** 一条工具输出原本有多长：页面上收到的是省掉后半段的（outputCut.len 是存盘的长度），存盘的又可能截过 */
export function resultChars(tool: { output?: string; outputCut?: { len: number } }): number {
  const out = tool.output ?? ''
  const stored = tool.outputCut?.len ?? out.length
  const m = OMITTED.exec(out)
  return stored + (m ? Number(m[1]) : 0)
}

/** 小于这个字数的不列：几百字的结果列出来也不说明什么 */
const MIN_CHARS = 2000

export function bigToolResults(messages: TaskMessage[], agentId: string, n = 5): BigResult[] {
  // 最近一次压缩之后的才在上下文里：压缩那一行可能和之后的工具调用在同一条消息里，按工具算位置
  let from = 0
  let fromTool = 0
  messages.forEach((m, idx) => {
    m.tools.forEach((x, i) => {
      if (x.kind === 'compact') [from, fromTool] = [idx, i + 1]
    })
  })
  const out: BigResult[] = []
  messages.slice(from).forEach((m, k) => {
    if (m.role !== 'agent' || (agentId && m.agentId && m.agentId !== agentId)) return
    m.tools.forEach((x, i) => {
      if (k === 0 && i < fromTool) return
      const chars = resultChars(x)
      if (chars < MIN_CHARS) return
      out.push({ msg: m.id, i, name: x.name ?? '', label: x.label, kind: x.kind, chars, tokens: tokensOfChars(chars) })
    })
  })
  return out.sort((a, b) => b.chars - a.chars).slice(0, n)
}
