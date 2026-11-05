import type { FileChange, TaskMessage, TurnChanges } from './schema.ts'

/**
 * 整个对话改了哪些文件：把每一轮记在总结消息上的改动（turnChanges，见 server/turn-changes.ts）按先后合起来。
 * 对话停下来以后，最后面那张「这个对话改了 N 个文件」卡片读它（以前每一轮总结下面各挂一张，用户要只看整个对话的）。
 *
 * 撤销过的那几轮不算；同一个文件在几轮里都改过时增删行数相加。spans 按先后拼起来，
 * 看差异、撤销都按这串 spans 走（server/exec/git.ts 的 spansFileDiff / undoSpans 本来就支持多段）
 */
export interface ConvChanges {
  spans: TurnChanges['spans']
  files: FileChange[]
  /** 带着改动的那几轮的总结消息 id：撤销时一起标上撤销过 */
  turns: string[]
  /** 改过、但都已经撤销的轮数：卡片上写「已撤销」 */
  reverted: number
}

export function convChanges(messages: Pick<TaskMessage, 'id' | 'turnChanges'>[]): ConvChanges {
  const spans: TurnChanges['spans'] = []
  const files = new Map<string, FileChange>()
  const turns: string[] = []
  let reverted = 0
  for (const m of messages) {
    const ch = m.turnChanges
    if (!ch?.files.length) continue
    if (ch.revertedAt) {
      reverted++
      continue
    }
    turns.push(m.id)
    spans.push(...ch.spans)
    for (const f of ch.files) {
      const had = files.get(f.path)
      if (had) files.set(f.path, { ...had, add: had.add + f.add, del: had.del + f.del })
      else files.set(f.path, { ...f })
    }
  }
  return { spans, files: [...files.values()], turns, reverted }
}
