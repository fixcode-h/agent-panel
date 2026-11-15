import { liftBugFields } from '../../shared/bug/task-bug.ts'
import type { Migration } from './index.ts'
import { liftTaskFiles } from './lift-tasks.ts'

/**
 * 任务记录上平铺的 Bug 字段（bug、bugFix、diagnoses、bugCase、fixBrief、logBase、bugMethodPending）收进 task.bug 子对象
 * （重构文档第 15 条，格式见 shared/bug/task-bug.ts）。只改原始 JSON 上的这几个键，别的原样；没有要改的不写盘
 */
export const taskBug: Migration = {
  version: 4,
  name: 'task-bug',
  async run(ctx) {
    const n = await liftTaskFiles(ctx, liftBugFields)
    if (n) ctx.log(`把 ${n} 个任务记录的 Bug 字段收进了 task.bug`)
  },
}
