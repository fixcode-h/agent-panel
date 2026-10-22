import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 项目目录是不是 agent-panel 自己的源代码：AI 分析给出的面板框架问题、角色优化
 * 只有在这样的项目里才能开子对话直接改进源代码。
 * 只看包名不够（别人也可能叫这个名字），再确认分析建议所在的文件存在
 */
export async function isPanelSource(dir: string) {
  if (!dir) return false
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    if (pkg.name !== 'agent-panel') return false
    await access(path.join(dir, 'shared', 'task-export.ts'))
    return true
  } catch {
    return false
  }
}
