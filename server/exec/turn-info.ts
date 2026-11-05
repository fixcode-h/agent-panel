import type { TaskMessage } from '../../shared/schema.ts'
import { isActTool } from '../../shared/end-turn.ts'

/**
 * 一轮结束时交给 onTurnEnd 的事实：tools 是这一轮调用过几次工具，acts 是其中动手的次数
 * （shared/end-turn.ts 的 isActTool：只读、搜索、面板自己的工具不算），since 是这一轮第一条输出的时间（判断计划是不是这一轮列的、收的）
 */
export interface TurnInfo {
  tools: number
  acts: number
  since: string
}

/** 按这一轮的消息算 TurnInfo（从 runner.ts 拆出来，那个文件有行数上限） */
export function turnInfo(tools: number, msgs: TaskMessage[]): TurnInfo {
  const acts = msgs.reduce((n, m) => n + m.tools.filter(isActTool).length, 0)
  return { tools, acts, since: msgs[0]?.at ?? '' }
}
