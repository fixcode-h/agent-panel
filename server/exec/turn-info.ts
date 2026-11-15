import type { TaskMessage, ToolUse } from '../../shared/schema.ts'
import { isActTool } from '../../shared/end-turn.ts'
import { readOnlyCommand } from './redirect.ts'

/**
 * 真动手的一次调用：改文件、跑会改东西的命令。只读的命令（rg、grep、git log、cat……）不算——
 * 新版 Claude Code 的搜索走命令行，只读问答也会跑好几条命令，以前满 3 条就被收尾自检再推一轮，
 * 多一句重复的收尾话（摸底报告第 18 条）。认不出的命令照旧算动手
 */
export function changedSomething(x: Pick<ToolUse, 'name' | 'label' | 'kind'> & { input?: unknown }) {
  if (!isActTool(x)) return false
  if (x.kind !== 'run') return true
  const cmd = x.label || (typeof x.input === 'string' ? x.input : '')
  return !readOnlyCommand(cmd)
}

/**
 * 一轮结束时交给 onTurnEnd 的事实：tools 是这一轮调用过几次工具，acts 是其中动手的次数
 * （changedSomething：改文件、跑会改东西的命令），since 是这一轮第一条输出的时间（判断计划是不是这一轮列的、收的）
 */
export interface TurnInfo {
  tools: number
  acts: number
  since: string
}

/** 按这一轮的消息算 TurnInfo（从 runner.ts 拆出来，那个文件有行数上限） */
export function turnInfo(tools: number, msgs: TaskMessage[]): TurnInfo {
  const acts = msgs.reduce((n, m) => n + m.tools.filter(changedSomething).length, 0)
  return { tools, acts, since: msgs[0]?.at ?? '' }
}
