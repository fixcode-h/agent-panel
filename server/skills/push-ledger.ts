/**
 * 技能推送账本：每个对话推过哪些技能、各多少字。技能推送（设计稿第一部分，另一路在做）按它判断「一个对话一个技能只推一次」，
 * 工具网关的调用记录（server/tool-gateway/）按它取「这次调用前后新推了哪些技能」。
 *
 * 这里是最小版本：只在内存里记，签名和推送那边约好的一样；两边合并时以推送那边的实现为准
 */
import { taskMap } from '../runtime/task-state.ts'

export interface SkillPush {
  skill: string
  chars: number
  tokens: number
  at: number
  /** 因为什么推的（改了 .lua、跑了 git……） */
  trigger: string
}

// 运行时（task-state 登记，对话删掉时跟着清）：重启后从头记，最多同一个技能再推一次
const pushes = taskMap<SkillPush[]>('skills.push-ledger 推过的技能')

export function recordSkillPush(taskId: string, e: SkillPush): void {
  const list = pushes.get(taskId) ?? []
  list.push(e)
  pushes.set(taskId, list)
}

export function skillPushes(taskId: string): SkillPush[] {
  return pushes.get(taskId) ?? []
}
