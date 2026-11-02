import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { handoffDirOf } from '../store.ts'
import { clip } from '../../shared/text.ts'

/** 父对话每轮提示里一条子对话消息最多放多少字（shared/engine.ts 的 inboxPart 按这个上限截） */
export const INBOX_CHARS = 2000

/**
 * 子对话发给父对话的消息交进提示词前：超长的全文存进交接目录（CLI 启动时就放行，见 handoffDirOf），
 * 提示里留开头和全文路径，总长不超过 INBOX_CHARS。原来直接截到 2000 字、不说全文在哪，
 * 子对话的长汇报后半截悄悄丢了（ADR 0041 第 14 节：截断必须留指针）。存不了文件就整段交回
 */
export function inboxWithFile(taskId: string, m: { title: string; text: string }) {
  if (m.text.length <= INBOX_CHARS) return m
  try {
    const file = path.join(handoffDirOf(taskId), `inbox-${randomUUID().slice(0, 8)}.md`)
    writeFileSync(file, `# ${m.title}\n\n${m.text}\n`)
    const pointer = `\n（完整消息有 ${m.text.length} 字，这里只附了开头。全文在文件 ${file}，处理前先读完。）`
    return { ...m, text: `${clip(m.text, Math.max(200, INBOX_CHARS - pointer.length - 1))}${pointer}` }
  } catch {
    return m
  }
}
