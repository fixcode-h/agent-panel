import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../store.ts'
import { MSG_LEGACY } from '../task-messages-file.ts'
import { fillTurnSeen, taskDirsIn } from './0001-task-layout.ts'
import type { Migration } from './index.ts'

/**
 * 服务端运行时算出来、不该存盘的字段（重构文档第 1 条拆 TaskRecord / TaskLive）：旧版本有时把它们一起写进了任务记录，
 * 重启后读回来会带着上一次的陈旧值。新代码在落盘前剥掉它们，这里把旧文件里留下的删掉
 */
export const RUNTIME_FIELDS = [
  'cliAlive',
  'jobs',
  'drafting',
  'childrenWorking',
  'childrenNeeds',
  'childrenCli',
  'askedAt',
] as const

/**
 * 任务记录的旧格式整理，原来每次读任务记录都要做一遍：
 * - 没有 turnSeenAt 的旧记录补成「看过」（原来在 task-store 的 parseTask 里）
 * - 删掉旧的运行时字段（见 RUNTIME_FIELDS）
 * 只改原始 JSON 上的这几个键，别的原样；没有要改的不写盘
 */
export const taskMetaCleanup: Migration = {
  version: 2,
  name: 'task-meta-cleanup',
  async run(ctx) {
    let n = 0
    for (const dir of await taskDirsIn(path.join(ctx.dataDir, 'tasks'))) {
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.json') || f.endsWith(MSG_LEGACY)) continue
        const file = path.join(dir, f)
        // 坏文件不管：读任务时 task-store 会留档并从对话重建
        const raw = (await readJson(file).catch(() => undefined)) as Record<string, unknown> | undefined
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        let dirty = fillTurnSeen(raw, raw as { turnSeenAt?: string; turnDoneAt?: string })
        if (dirty && typeof raw.turnSeenAt !== 'string') raw.turnSeenAt = ''
        for (const k of RUNTIME_FIELDS)
          if (k in raw) {
            delete raw[k] // delete-ok: 原始 JSON 对象，不是经 store.update 合并的 Task
            dirty = true
          }
        if (!dirty) continue
        await ctx.backup(file)
        await writeJsonAtomic(file, raw)
        n++
      }
    }
    if (n) ctx.log(`整理了 ${n} 个任务记录（补 turnSeenAt、删旧的运行时字段）`)
  },
}
