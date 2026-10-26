/**
 * 假 CLI 在工作目录留下的输出文件：文件名只在这里定义一次。
 *
 * 假 CLI 每一轮都会往当前目录写 `<kind>-output.txt`（用来测工具调用、改动统计和改动预览），
 * 而 e2e 的项目目录本身是一个 git 仓库：这些文件是未跟踪的，子对话的独立分支里也有一份同名的，
 * `git merge` 遇到「未跟踪文件会被覆盖」会直接拒绝，合并用例就变成 409 挂掉。
 * 所以测试里合并分支、判断工作区是否干净之前，都用这里的函数把残留统一清一遍。
 */
import { rmSync } from 'node:fs'
import path from 'node:path'

/** 假 CLI 按参数认出来的 kind：每种都会在工作目录写一个输出文件 */
export const CLI_OUTPUT_KINDS = ['claude', 'codex', 'commandcode', 'gemini', 'pi']

/** 某种 CLI 在工作目录写的输出文件名 */
export const cliOutputFile = (kind) => `${kind}-output.txt`

/** 全部假 CLI 输出文件名：清理和断言共用这一份列表 */
export const CLI_OUTPUT_FILES = CLI_OUTPUT_KINDS.map(cliOutputFile)

/** 清掉 dir 里所有假 CLI 输出文件（没有也当成清掉：残留本来就不该在） */
export function clearCliOutputs(dir) {
  for (const f of CLI_OUTPUT_FILES) rmSync(path.join(dir, f), { force: true })
}
