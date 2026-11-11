import path from 'node:path'
import { statSync } from 'node:fs'
import type { HookFacts } from '../../shared/hooks.ts'
import { runSegments, segHead } from '../../shared/command-scope.ts'

/**
 * 少占上下文的守卫和提醒（工作包 I，「Agent 模式可优化与扩展点」优化 4）：工具结果进了 CLI 的会话就一直跟着，
 * 之后每次请求都带上，直到被压缩；面板改不了已经返回的结果，只能在进来之前拦一下、进来之后提醒下次换个做法。
 * 和 guards.ts 一样只看结构化的事实（工具类别、路径、文件大小、结果字数），不读模型回复的文字
 */

/** 二进制和图片：读文件工具按图片、分页处理，不是整段文字进上下文，不拦 */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb|uasset|umap|zip|7z|exe|dll)$/i

/** 整份打印文件的命令：cat、type、PowerShell 的 Get-Content（带 -Tail / -TotalCount / -Head 的只取一段，不算） */
const DUMP_HEADS = new Set(['cat', 'type', 'get-content', 'gc'])
const DUMP_RANGE = /\s-(tail|totalcount|head|first|last)\b/i

/** 同一个对话里拦过一次的文件：再要整份读就放行（它确实要通读时不至于卡死），记在内存里，重启清空 */
const warned = new Map<string, Set<string>>()

const sizeOf = (p: string) => {
  try {
    const st = statSync(p)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/** 一条 shell 命令整份打印了哪些文件：只认单独一段、没有管道和重定向的 cat / type / Get-Content */
function dumpedFiles(command: string): string[] {
  if (/[|>]/.test(command)) return []
  const segs = runSegments(command)
  if (segs.length !== 1 || !DUMP_HEADS.has(segHead(segs[0])) || DUMP_RANGE.test(segs[0])) return []
  return segs[0]
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => a.replace(/^["']|["']$/g, ''))
}

/**
 * 读大文件前拦一下：整份读超过阈值（KB）的文本文件时拒绝，让它先搜再按行读、只读结尾，或派子任务去读。
 * 读文件工具只管 CLI 定义里写了分段参数的（ranged 有值）；shell 里只管单独一条 cat / type / Get-Content。
 * 同一个文件拦一次：它说明了要通读、再读一次就放行
 */
export function bigReadDeny(cwd: string, taskId: string, kb: number, facts: HookFacts): string {
  const tool = facts.tool
  if (!tool || kb <= 0) return ''
  const files =
    tool.kind === 'read' && tool.ranged === false && tool.path
      ? [tool.path]
      : tool.kind === 'shell'
        ? dumpedFiles(String(tool.input.command ?? ''))
        : []
  const seen = warned.get(taskId) ?? new Set<string>()
  for (const f of files) {
    if (BINARY_EXT.test(f)) continue
    const abs = path.resolve(cwd, f)
    const size = sizeOf(abs)
    if (size <= kb * 1024 || seen.has(abs)) continue
    seen.add(abs)
    warned.set(taskId, seen)
    const how =
      tool.kind === 'read'
        ? '先用 rg -n 搜到要看的行，再带 offset / limit 只读那几段'
        : '先用 rg -n 搜到要看的行，再用 sed -n / head / tail（PowerShell 用 Select-String、Get-Content -Tail）只取那几段'
    return `【面板】${f} 有 ${Math.round(size / 1024)} KB，整份读进来会一直占着上下文、之后每轮都要带着：${how}；日志只看结尾；确实要通读全文，派一个子任务去读、只交回结论。确实要整份读进来就再读一次，面板不再拦。`
  }
  return ''
}

/**
 * 输出大的工具调用事后提醒：一次结果超过阈值（字）时补一句，下次先重定向到文件再搜，或放后台、派子任务。
 * 结果已经进了会话，这句只管下一次；字数按 CLI 交来的原文算（钩子输入里的结果截短前的长度）
 */
export function bigOutputHint(facts: HookFacts, chars: number, canBackground: boolean): string {
  const tool = facts.tool
  const size = tool?.result?.size ?? 0
  if (!tool || chars <= 0 || size <= chars || (tool.kind !== 'shell' && tool.kind !== 'read')) return ''
  const what = tool.kind === 'shell' ? '这条命令的输出' : '这次读进来的内容'
  const bg = canBackground ? '；编译、测试这类长命令交给 run_background，只回结尾和错误' : ''
  return `【面板】${what}有 ${size} 字，已经整段进了上下文、之后每轮都要带着。下次可能输出很多时，先重定向到项目 .tmp/ 下的文件，再用 rg 搜要的行${bg}；要从大文件、大日志里找东西就派子任务去读，只交回结论。`
}
