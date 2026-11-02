import { HANDOFF_DIR } from '../store.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 交接内容存成文件，返回路径。子任务的 id 带「/」（@chat/sub/h3）：直接拿来当文件名会落进不存在的子目录，
 * 写盘失败后结果只剩开头、也没有路径（评审意见被截断的原因），所以文件名里不能当路径的字符都换掉
 */
export async function saveHandoffFile(
  taskId: string,
  step: { id: string; title: string },
  text: string,
  root = HANDOFF_DIR,
) {
  const dir = path.join(root, taskId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${handoffName(step.id)}.md`)
  await writeFile(file, `# ${step.title}\n\n${text}\n`)
  return file
}

/** 步骤 id 变成一个安全的文件名（Windows 也能用）：路径分隔符和保留字符都换成「_」 */
export const handoffName = (id: string) => id.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^[._]+/, '') || 'step'
