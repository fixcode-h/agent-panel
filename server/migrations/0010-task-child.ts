import { liftChildFields } from '../../shared/children/task-child.ts'
import type { Migration } from './index.ts'
import { liftTaskFiles } from './lift-tasks.ts'

/**
 * 任务记录上平铺的、只有子对话用的字段（wrapRequest、buildAsk、handoff、pendingReport、userDirect、parentAsks、autoAsk）
 * 收进 task.child 子对象，键名不变（复查报告 A7，格式见 shared/schema.ts 的 TaskChild）。只改原始 JSON 上的这几个键，别的原样；没有要改的不写盘
 */
export const taskChild: Migration = {
  version: 10,
  name: 'task-child',
  async run(ctx) {
    const n = await liftTaskFiles(ctx, liftChildFields)
    if (n) ctx.log(`把 ${n} 个任务记录的子对话字段收进了 task.child`)
  },
}
