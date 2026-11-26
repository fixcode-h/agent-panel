/**
 * 技能条件和用户改动的存盘形状（ADR 0083）：只依赖 zod 的叶子文件，钩子配置（shared/hooks/defs.ts 的 HooksData.skills）
 * 直接引它，不会和条件匹配那几个文件绕成循环引用。条件的含义见 ./when.ts
 */
import { z } from 'zod'

export const SKILL_WHEN_KINDS = [
  'edit',
  'read',
  'command',
  'tool',
  'failed',
  'phase',
  'project',
  'message',
  'params',
] as const
export type SkillWhenKind = (typeof SKILL_WHEN_KINDS)[number]

/** phase 的取值 */
export const SKILL_PHASES = ['finishing', 'finishing-edited', 'bug'] as const

export const SkillWhen = z.object({
  kind: z.enum(SKILL_WHEN_KINDS),
  value: z.string().trim().min(1).max(300),
})
export type SkillWhen = z.infer<typeof SkillWhen>

/** 用户在设置里对一个技能的改动：没写的跟默认 */
export const SkillOverride = z.object({
  /** 关掉 / 打开自动推（默认看技能目录的 autoPush） */
  on: z.boolean().optional(),
  /** 每个对话都带：当成所有角色的自带技能 */
  always: z.boolean().optional(),
  /** 换掉默认条件 */
  when: z.array(SkillWhen).max(20).optional(),
})
export type SkillOverride = z.infer<typeof SkillOverride>
