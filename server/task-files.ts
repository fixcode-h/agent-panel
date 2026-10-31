import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { log } from './log.ts'
import { TASK_FILE_KINDS, TASK_FILES_DIR } from './store.ts'

/**
 * 告诉 Agent 自己产出的临时东西放哪（用户 2026-10-31 定的）：以前截图、临时测试脚本散落在项目里，
 * 还会随手建 temp、tmp 文件夹，既弄脏项目，又说不清是哪个对话留下的
 */
function taskFilesRule(dir: string) {
  return `## 截图和临时文件放哪
这个对话的对话目录是 \`${dir}\`。你自己产出的截图放它下面的 screenshots/，临时测试脚本和测试数据放 tests/，其余临时文件（导出的日志、中间结果、草稿）放 tmp/。
不要在项目目录里、系统临时目录或别的地方另建 temp、tmp、screenshots 这类文件夹，也不要把这些东西留在项目里。项目自己规定的测试、截图位置（例如项目的测试目录、项目文档要求的截图目录）照项目的规定；要交付给用户的文件按用户说的位置放。`
}

/** 这一轮开工前把对话目录和几个子目录建好，返回目录（交给 CLI 放行）和写进系统提示词的那段规则 */
export async function taskFiles(taskId: string) {
  const dir = path.join(TASK_FILES_DIR, taskId)
  await Promise.all(TASK_FILE_KINDS.map((k) => mkdir(path.join(dir, k), { recursive: true }))).catch((e) =>
    log.warn('agent', '建对话目录失败', { task: taskId, error: (e as Error).message }),
  )
  return { dir, rule: taskFilesRule(dir) }
}
