import { runSegments, segHead } from '../../shared/command-scope.ts'
import { tokenize } from '../../shared/tool-gateway/search-args.ts'

/**
 * 命令行里要改的版本管理文件（给 P4 改前签出钩子用）：Edit 类工具以外，Agent 也常在命令行里改文件——
 * 2026-11-26 复盘 P0-1：Agent 用 python/openpyxl 改 xlsx、再自己 `p4 edit`，钩子只看 Edit 类工具，
 * 「库里新了两版、别人还开着」的表格照改了。这里认两种写法：
 * - `p4 edit / open <文件…>`：Agent 自己签出，说明马上要改；
 * - 命令里点名了没法合并的资源文件（表格、UE 资源、图片…），并且带着写文件的动作（`.save(`、复制、移动、写出）。
 * 只认得出写法的；认不出的（读一下就算的）不管，宁可漏不错拦。
 */

/** 没法合并、改错了只能二选一的文件：命令行里点名它们又带写动作时按「要改」算 */
const BINARY_EXT = 'xlsx|xlsm|xls|uasset|umap|png|jpg|jpeg|tga|psd|fbx|docx|pptx|pdf'
const BINARY_PATH = new RegExp(`(?:[A-Za-z]:)?[\\w./\\\\:-]*[\\w-]\\.(?:${BINARY_EXT})(?![\\w])`, 'gi')
/** 写文件的动作：python 的 .save( / to_excel(、shell 的复制移动、PowerShell 的写出 */
const WRITES =
  /\.save\s*\(|\bsave_workbook\b|\.to_excel\s*\(|\bshutil\.(?:copy|move)|\b(?:cp|mv|copy|move|Copy-Item|Move-Item|Set-Content|Out-File)\b/i

/** p4 子命令后面的参数里，这些开关带一个值（-c 123），值不是文件 */
// 模块状态：常量，加载后不改
const P4_VALUE_FLAGS = new Set(['-c', '-t', '-C', '-p', '-u', '-P', '-H'])

/** 一段 `p4 [全局开关] edit|open [开关] 文件…` 里的文件 */
function p4EditFiles(seg: string): string[] {
  // 引号按 shell 规则切（共用搜索参数的切法）；切不了（变量、命令替换）就不认
  const args = (tokenize(seg) ?? []).map((t) => t.v).slice(1)
  // 跳过 p4 的全局开关（-c client、-u user…），找到子命令
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += P4_VALUE_FLAGS.has(args[i]) ? 2 : 1
  if (!/^(edit|open)$/.test(args[i] ?? '')) return []
  const out: string[] = []
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j]
    if (a.startsWith('-')) {
      if (P4_VALUE_FLAGS.has(a)) j++
      continue
    }
    // depot 路径（//depot/...）和通配符交给 P4 自己，不归钩子算
    if (a.startsWith('//') || /[*?]|\.\.\./.test(a)) continue
    out.push(a)
  }
  return out
}

/** 命令里要改的文件（相对路径按命令执行目录算，由调用方 resolve） */
export function shellWriteTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of runSegments(command)) if (segHead(seg) === 'p4') out.push(...p4EditFiles(seg))
  if (WRITES.test(command))
    for (const m of command.matchAll(BINARY_PATH)) {
      const p = m[0].replace(/^[\\/]+(?=[A-Za-z]:)/, '')
      if (!/^(?:https?|ftp):/i.test(p)) out.push(p)
    }
  return [...new Set(out)]
}

/** p4 输出里说「本地不是最新」「别人也打开着」的文件（工具后兜底：钩子之前没拦到时补一句） */
export function p4ConflictLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((l) => /must sync\/resolve|also opened by|exclusive file already opened/i.test(l))
    .map((l) => l.trim())
    .slice(0, 8)
}
