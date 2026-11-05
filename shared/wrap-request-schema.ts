import { z } from 'zod'

/**
 * 子对话请父对话收尾的记录（见 ADR 0005）：子对话只剩合回时调用 submit_merge 写 requested，
 * 父对话 finish_child 合并时是 merging，和原分支冲突、退回子对话时是 failed（info 写原因；父对话目录挡路时留 requested）。
 * 收尾做完（resolved）或者子对话又开始干活时清掉。从 schema.ts 拆出来（那边到了行数上限）
 */
export const WrapRequest = z.object({
  /**
   * testing：已经合回，父对话在跑勾了「禁止子对话执行」的测试步骤（见 ADR 0018）；
   * test-failed：已经合回、父对话测试没通过，正在退回给子对话修（和「没合进去」的 failed 是两回事）
   */
  state: z.enum(['requested', 'merging', 'failed', 'testing', 'test-failed']),
  at: z.string(),
  note: z.string().default(''),
  tests: z.string().default(''),
  /** UE 项目：合回去后父对话要接着编译（独立分支里编不了 UE，见 ADR 0004） */
  build: z.boolean().optional(),
  info: z.string().default(''),
})
export type WrapRequest = z.infer<typeof WrapRequest>
