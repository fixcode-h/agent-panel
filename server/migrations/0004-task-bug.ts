import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { liftBugFields } from '../../shared/bug/task-bug.ts'
import { readJson, writeJsonAtomic } from '../store.ts'
import { MSG_LEGACY } from '../tasks/messages-file.ts'
import { taskDirsIn } from './0001-task-layout.ts'
import type { Migration } from './index.ts'

/**
 * 任务记录上平铺的 Bug 字段（bug、bugFix、diagnoses、bugCase、fixBrief、logBase、bugMethodPending）收进 task.bug 子对象
 * （重构文档第 15 条，格式见 shared/bug/task-bug.ts）。只改原始 JSON 上的这几个键，别的原样；没有要改的不写盘
 */
export const taskBug: Migration = {
  version: 4,
  name: 'task-bug',
  async run(ctx) {
    let n = 0
    for (const dir of await taskDirsIn(path.join(ctx.dataDir, 'tasks'))) {
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.json') || f.endsWith(MSG_LEGACY)) continue
        const file = path.join(dir, f)
        // 坏文件不管：读任务时 task-store 会留档并从对话重建
        const raw = (await readJson(file).catch(() => undefined)) as Record<string, unknown> | undefined
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        if (!liftBugFields({ ...raw })) continue
        await ctx.backup(file)
        liftBugFields(raw)
        await writeJsonAtomic(file, raw)
        n++
      }
    }
    if (n) ctx.log(`把 ${n} 个任务记录的 Bug 字段收进了 task.bug`)
  },
}
