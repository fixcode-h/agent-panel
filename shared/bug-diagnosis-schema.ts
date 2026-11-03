import { z } from 'zod'

/**
 * Bug 的诊断报告（ADR 0045）：父对话派来的 Bug，子对话查到根因、修之前交这份报告，用户确认了方案才能改。
 * 只放 zod 结构（schema.ts 引用它，避免循环）；渲染、校验、收尾核对在 bug-diagnosis.ts
 */

/**
 * 用户在报告上的标注：question 是疑问（要它查清、补证据），change 是改方案（换修法、改范围），
 * info 是补充信息（用户知道的事实，不用回答，下一版要用上）。answer 是下一版里 Agent 对这条的回答
 */
export const DiagnosisNote = z.object({
  id: z.number().int(),
  quote: z.string().max(2000).default(''),
  kind: z.enum(['question', 'change', 'info']).default('question'),
  comment: z.string().max(4000).default(''),
})
export type DiagnosisNote = z.infer<typeof DiagnosisNote>

export const Diagnosis = z.object({
  version: z.number().int(),
  at: z.string(),
  symptom: z.string().default(''),
  repro: z.string().default(''),
  location: z.string().default(''),
  evidence: z.string().default(''),
  rootCause: z.string().default(''),
  /** 根因已经用日志、测试证实；false 是还只是假设（报告上标出来） */
  confirmed: z.boolean().default(false),
  excluded: z.string().default(''),
  fix: z.string().default(''),
  /** 方案里要改的文件（相对项目根）：收尾时实际改动按它核对 */
  files: z.array(z.string()).default([]),
  risk: z.string().default(''),
  verify: z.string().default(''),
  /** 第 2 版起：逐条回答上一版的疑问和改方案（id 对上一版 notes 的 id） */
  answers: z.array(z.object({ id: z.number().int(), answer: z.string() })).default([]),
  status: z.enum(['pending', 'questioned', 'approved', 'superseded']).default('pending'),
  notes: z.array(DiagnosisNote).default([]),
  overall: z.string().default(''),
  decidedAt: z.string().optional(),
  /** 交报告时工作区已经改了的文件：确认之前就动了手的，审阅时摆出来 */
  before: z.array(z.string()).default([]),
})
export type Diagnosis = z.infer<typeof Diagnosis>
