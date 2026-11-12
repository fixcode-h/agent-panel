import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { TaskMessage } from '../../shared/schema.ts'
import { readJsonDetailed, writeTextAtomic } from '../store.ts'
import { MSG_JSONL, MSG_LEGACY, messagesToJsonl } from '../task-messages-file.ts'
import { taskDirsIn } from './0001-task-layout.ts'
import type { Migration } from './index.ts'

/**
 * 对话文件从整份重写的 `<id>.messages.json` 换成追加写的 `<id>.messages.jsonl`（重构文档第 7 条，格式见 task-messages-file.ts）。
 * 先写好新文件，再把旧文件挪进备份目录（不复制，几 MB 的对话不占双份空间）。
 * 读不懂的旧文件不动：留在原位，task-store 读的时候会按坏文件留档处理
 */
export const messagesJsonl: Migration = {
  version: 3,
  name: 'messages-jsonl',
  async run(ctx) {
    let n = 0
    let skipped = 0
    for (const dir of await taskDirsIn(path.join(ctx.dataDir, 'tasks'))) {
      for (const f of await readdir(dir)) {
        if (!f.endsWith(MSG_LEGACY)) continue
        const old = path.join(dir, f)
        const jsonl = old.slice(0, -MSG_LEGACY.length) + MSG_JSONL
        // 新旧两份都在：JSONL 是面板读到旧文件后整份写出来的，比旧文件新，旧的直接挪走
        if (existsSync(jsonl)) {
          await ctx.moveToBackup(old)
          n++
          continue
        }
        const res = await readJsonDetailed(old)
        if (res.state !== 'ok') continue
        const p = TaskMessage.array().safeParse(res.value)
        if (!p.success) {
          skipped++
          continue
        }
        await writeTextAtomic(jsonl, messagesToJsonl(p.data))
        await ctx.moveToBackup(old)
        n++
      }
    }
    if (n) ctx.log(`${n} 个对话文件转成了追加写的格式`)
    if (skipped) ctx.log(`${skipped} 个对话文件内容不是消息列表，原样留着`)
  },
}
