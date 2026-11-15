import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../store.ts'
import { MSG_LEGACY } from '../tasks/messages-file.ts'
import { taskDirsIn } from './0001-task-layout.ts'
import type { MigrationCtx } from './index.ts'

/**
 * 「把任务记录上平铺的一组字段收进子对象」这类迁移共用的遍历（0004 起的写法）：逐个读任务记录，
 * lift 先在一份浅拷贝上试，要改才备份、就地改、写回。返回改了几个文件。
 * 坏文件不管：读任务时 task-store 会留档并从对话重建
 */
export async function liftTaskFiles(
  ctx: MigrationCtx,
  lift: (raw: Record<string, unknown>) => boolean,
): Promise<number> {
  let n = 0
  for (const dir of await taskDirsIn(path.join(ctx.dataDir, 'tasks'))) {
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json') || f.endsWith(MSG_LEGACY)) continue
      const file = path.join(dir, f)
      const raw = (await readJson(file).catch(() => undefined)) as Record<string, unknown> | undefined
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      // 先在拷贝上试：没有要改的不备份、不写盘（深拷贝，lift 可能改到子对象）
      if (!lift(structuredClone(raw))) continue
      await ctx.backup(file)
      lift(raw)
      await writeJsonAtomic(file, raw)
      n++
    }
  }
  return n
}
