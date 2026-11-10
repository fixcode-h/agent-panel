import { z } from 'zod'

/**
 * Agent 用 end_turn 交代的「这一轮怎么结束」（设计稿 docs/openspec/changes/end-check-signal/design-v2.md）：
 * done 是做完了，blocked 是做不下去、need 写缺什么。结束前钩子和一轮结束后的提醒只认这份记录，不读回复文字。
 * 从 schema.ts 拆出来：那个文件到了行数上限
 */
export const EndTurnRecord = z.object({
  at: z.string(),
  outcome: z.enum(['done', 'blocked']),
  need: z.string().optional(),
})
export type EndTurnRecord = z.infer<typeof EndTurnRecord>
