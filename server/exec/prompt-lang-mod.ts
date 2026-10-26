/**
 * Command Code 没有 --append-system-prompt，只能靠 --mod 加载的插件追加系统提示词。
 * 面板写一个只做这件事的 mod：运行时从环境变量取当前语言，把「回复正文和思考过程」的规则追加到系统提示词末尾。
 *
 * 为什么不能只写在任务描述里：实测同一段规则放在任务描述中（约 39% 位置）时，DeepSeek 的原生思考仍按英文系统提示词
 * 输出英文；追加到系统提示词后同一提示词的思考变成中文。规则按语言取值，所以切换语言不用重写文件。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PROMPT_LANG_ENV, promptLangModSource } from '../../shared/prompt-lang.ts'
import { DATA_DIR } from '../store.ts'

export { PROMPT_LANG_ENV, promptLangModSource }

export const promptLangModFile = () => path.join(DATA_DIR, 'mods', 'agent-panel-prompt-lang.mjs')

let written = ''

/** 确保 mod 文件存在且是最新内容，返回路径；内容没变时不重复写 */
export async function ensurePromptLangMod() {
  const file = promptLangModFile()
  const body = promptLangModSource()
  if (written === body) return file
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body, 'utf8')
  written = body
  return file
}
