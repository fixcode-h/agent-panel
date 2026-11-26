/**
 * 设置「Agent 工具」一节的接口契约（写法见 ./define.ts）。第一期是「技能」页签（ADR 0083）：技能目录的每一行、
 * 改开关和条件、某个技能最近的推送、单个对话推送总量的上限。「调用记录」页签的接口以后加在这里
 */
import { z } from 'zod'
import { SkillPatch, SkillRow } from '../skills/rows.ts'
import { endpoint } from './define.ts'

export const SkillList = z.object({
  skills: z.array(SkillRow),
  /** 一个对话最多推多少 token 的正文（内置钩子 skill-push 的参数） */
  limit: z.number(),
  /** 「按情境推技能」开着（设置 → 钩子里能整个关掉） */
  enabled: z.boolean(),
})
export type SkillList = z.infer<typeof SkillList>

export const SkillPushRecord = z.object({
  taskId: z.string(),
  /** 对话标题；对话没了为空 */
  title: z.string(),
  at: z.string(),
  chars: z.number(),
  tokens: z.number(),
  trigger: z.string(),
})
export type SkillPushRecord = z.infer<typeof SkillPushRecord>

export const agentToolsContract = {
  skills: endpoint({ method: 'GET', path: '/agent-tools/skills', res: SkillList }),
  updateSkill: endpoint({ method: 'PUT', path: '/agent-tools/skills/:name', body: SkillPatch, res: SkillRow }),
  skillPushes: endpoint({
    method: 'GET',
    path: '/agent-tools/skills/:name/pushes',
    res: z.object({ pushes: z.array(SkillPushRecord) }),
  }),
  setSkillLimit: endpoint({
    method: 'PUT',
    path: '/agent-tools/skill-limit',
    body: z.object({ tokens: z.number().int().min(0).max(200000) }),
    res: z.object({ tokens: z.number() }),
  }),
}
