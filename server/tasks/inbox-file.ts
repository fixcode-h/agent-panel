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
  return m.text.length <= INBOX_CHARS ? m : { ...m, text: clipWithFile(taskId, m.title, m.text, INBOX_CHARS) }
}

/**
 * 拼进给模型的话里的一段长文本：超过 limit 时全文存进 taskId 的交接目录，只留开头和全文路径（总长不超过 limit）。
 * 存不了文件就整段交回，不悄悄丢掉后半段（ADR 0041 第 14 节）
 */
export function clipWithFile(taskId: string, title: string, text: string, limit: number): string {
  if (text.length <= limit) return text
  try {
    const file = saveToHandoff(taskId, title, text)
    const pointer = `\n（完整内容有 ${text.length} 字，这里只附了开头。全文在文件 ${file}，处理前先读完。）`
    return `${clip(text, Math.max(200, limit - pointer.length - 1))}${pointer}`
  } catch {
    return text
  }
}

/** 全文存进 taskId 的交接目录（CLI 启动时已放行），返回路径；写盘失败时抛错，由调用方决定退回整段 */
export function saveToHandoff(taskId: string, title: string, text: string): string {
  const file = path.join(handoffDirOf(taskId), `inbox-${randomUUID().slice(0, 8)}.md`)
  writeFileSync(file, `# ${title}\n\n${text}\n`)
  return file
}
