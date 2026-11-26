/**
 * 校验、改道交给 Agent 的说明（ADR 0086）：改完自动跑的结果、代答时的结果、改用哪个工具。都是提示词，不翻译；
 * 长度按 ADR 0067（默认不超过 4000 字）。没报错时自动校验什么都不说（用户 2026-11-26 定：没报错不打扰）
 */
import { clipText, type ToolRunResult } from '../../custom-tools/text.ts'
import type { ClaimCtx } from '../../capability-router/capabilities.ts'
import type { VerifyRun } from './types.ts'

/** 一次校验跑完：记录里的那份 + 给 Agent 看的报错和尾部 */
export interface VerifyOutput {
  run: VerifyRun
  errors: ToolRunResult['errors']
  tail: string[]
}

const ERR_MAX = 20

const errLines = (o: VerifyOutput) =>
  o.errors
    .slice(0, ERR_MAX)
    .map((e) => `  ${e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : ''}${e.msg}`)
    .join('\n') + (o.errors.length > ERR_MAX ? `\n  ……还有 ${o.errors.length - ERR_MAX} 处` : '')

const who = (r: VerifyRun) => `自建工具「${r.name}」（${r.tool}）`
const log = (r: VerifyRun) => (r.logFile ? `\n完整日志：${r.logFile}` : '')

/** 一个工具这次的结果写成一段；通过的返回空串 */
function oneNote(o: VerifyOutput): string {
  const r = o.run
  const files = `${r.files.length} 个文件`
  if (r.outcome === 'ok') return ''
  if (r.outcome === 'errors')
    return `${who(r)}查了你刚改的 ${files}，有 ${r.errors} 处报错，先改好再继续：\n${errLines(o)}${log(r)}`
  if (r.outcome === 'failed')
    return `${who(r)}查了你刚改的 ${files}，没通过（没认出具体报错行），输出最后几行：\n${o.tail.slice(-12).join('\n')}${log(r)}`
  if (r.outcome === 'timeout')
    return `${who(r)}查你刚改的 ${files}时超过限时，面板已停下：这批改动还没校验完。${r.note ?? ''}不一定是代码的问题；需要的话用 custom_tool action=run id=${r.tool} 自己跑一次，或告诉用户这个检查太慢。`
  return `${who(r)}没跑起来：${r.note ?? '原因不明'}。这是检查工具本身的问题，不是你的代码：告诉用户在「技能与 MCP → 工具」里修它；你刚改的 ${files}先按项目说明里的检查方式自己确认。`
}

/** 改完自动校验推回去的补充说明：全部通过时为空串（不打扰） */
export function verifyNote(outs: VerifyOutput[]): string {
  const parts = outs.map(oneNote).filter(Boolean)
  if (!parts.length) return ''
  const more = outs.map((o) =>
    o.run.note && o.run.outcome !== 'timeout' && o.run.outcome !== 'spawn' ? o.run.note : '',
  )
  return clipText(
    `【面板】改完自动校验：${parts.join('\n\n')}${more
      .filter(Boolean)
      .map((m) => `\n（${m}）`)
      .join('')}`,
    4000,
  )
}

/**
 * 改道代答：Agent 自己跑的命令由面板改用自建工具跑了，结果放在拒绝说明里，开头只写「结果（面板）」（设计稿 5.2）。
 * 顺带把这个工具什么时候用、怎么调写给 Agent（用户 2026-11-26 提）：只说「以后用它」时 Agent 记不住参数，下次照样拼 luac
 */
export function serveText(command: string, outs: VerifyOutput[], how: { useWhen?: string; arg?: string } = {}): string {
  const r = outs[0]?.run
  const id = r?.tool ?? ''
  const call = `custom_tool action=run id=${id}${how.arg ? ` args={"${how.arg}": "<要查的文件>"}` : ''}`
  const when = how.useWhen ? `（${how.useWhen.slice(0, 80)}）` : ''
  const head = `结果（面板）：你要跑的 ${command.trim().slice(0, 200)} 由面板改用项目的${r ? who(r) : '自建工具'}跑了，不用再跑原命令。以后遇到同样的事${when}直接调 ${call}，改完对得上的文件面板也会自动跑它。`
  const body = outs.map((o) =>
    o.run.outcome === 'ok' ? `查了 ${o.run.files.join('、') || '项目'}：通过，没有报错。` : oneNote(o),
  )
  return clipText(`${head}\n${body.join('\n\n')}`, 4000)
}

/** 改用：不执行原命令，说明改用哪个工具、参数怎么填（设计稿 5.2 的 redirect） */
export function redirectText(to: string, ctx: Pick<ClaimCtx, 'build' | 'customTools'>, command: string): string {
  const cmd = command.trim().slice(0, 200)
  if (to === 'request_build')
    return ctx.build === 'child'
      ? `【面板】UE 的编译不在子对话里自己跑（${cmd}）：改用 request_build 向父对话申请编译，note 写改了哪些模块和文件、需要编哪个目标、做过哪些检查；编译结果面板会推回来。`
      : `【面板】UE 的编译交给面板（${cmd}）：改用 request_build，note 写为什么编译、包含哪些改动，替子对话编时 children 写它们的 id。面板按编译目录排队、同一目录同时只编一次，结果推回来；不要自己跑 Build.bat / UBT。`
  const id = to.startsWith('custom_tool:') ? to.slice('custom_tool:'.length) : to
  const t = ctx.customTools.find((x) => x.id === id)
  const arg = t?.fileParam ? ` args={"${t.fileParam}": "<文件>"}` : ''
  return `【面板】这件事项目做成了自建工具「${t?.name ?? id}」（${id}），面板没有替你跑原命令（${cmd}）：改用 custom_tool action=run id=${id}${arg}（参数不清楚先 action=show id=${id}）；会改文件的工具会先请用户授权。`
}
