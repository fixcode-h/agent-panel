import fs from 'node:fs/promises'
import path from 'node:path'
import type { TaskMessage } from '../../shared/schema.ts'
import type { TurnOutput } from '../../shared/turn-outputs/pick.ts'
import { spansNameStatus } from '../exec/git.ts'

/**
 * 「本轮产出」（设计稿 6.7，挑文件见 shared/turn-outputs/pick.ts）：界面交上来这一轮的几条消息和候选文件，
 * 这里按那几条消息记下的快照（server/turn/changes.ts）查每个文件是新建还是修改、现在多大。
 * 删掉的、快照里没有的（不是这一轮改的）、磁盘上已经不在的都剔掉
 */
export async function turnOutputs(dir: string, msgs: TaskMessage[], ids: string[], paths: string[]) {
  const want = new Set(paths)
  const status = new Map<string, TurnOutput['status']>()
  for (const m of msgs) {
    const ch = m.turnChanges
    if (!ids.includes(m.id) || !ch || ch.revertedAt) continue
    const mine = ch.files.map((f) => f.path).filter((p) => want.has(p))
    for (const [p, st] of await spansNameStatus(dir, ch.spans, mine)) {
      if (st === 'deleted') status.delete(p)
      // 前一段新建、后一段又改：还是新建
      else if (status.get(p) !== 'added') status.set(p, st)
    }
  }
  const root = path.resolve(dir)
  const out: TurnOutput[] = []
  // 按界面交上来的顺序返回，和改动卡片的顺序一致
  for (const p of paths) {
    const st = status.get(p)
    if (!st) continue
    const full = path.resolve(root, p)
    const rel = path.relative(root, full)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const size = await fs
      .stat(full)
      .then((x) => (x.isFile() ? x.size : -1))
      .catch(() => -1)
    if (size >= 0) out.push({ path: p, status: st, size })
  }
  return out
}
