/**
 * 能力「校验」（verify）和「改动生效」（apply）认哪些调用、打开改道后改到哪（ADR 0086，设计稿 6.2、第 8 节）。
 * capabilities.ts 里这两行各调这里一个函数；网关改道时怎么做（代答还是改用、说明怎么写）在 shared/tool-gateway/verify/plan.ts。
 *
 * - 校验：Agent 自己跑一个自建工具做的事（命令里的程序，或工具 role.replaces 登记的 luac 这类）。面板能替它跑的
 *   （只读、参数填得上）代答；填不上参数、会改文件的只能改用（会改文件的要过授权卡，路由不能绕过确认，设计稿 6.1）；
 * - 改动生效：UE 的编译命令（Build.bat、UBT、RunUAT、msbuild）改用 request_build（这一轮挂了它时），
 *   没挂时改用项目里标了 role=build 的自建工具；Agent 自己跑 build 工具的程序也指到它。
 * 编译一律只「改用」不代答：编译是占位的资源、要排队，面板不能在工具前回答里替它等完（设计稿 5.2 的 redirect）
 */
import { sigMatches, type CustomToolSig } from '../custom-tools/match.ts'
import { globRe } from '../text-match/index.ts'
import type { ToolCall } from '../tool-gateway/types.ts'
import type { Claim, ClaimCtx } from './capabilities.ts'

const single = (c: ToolCall) => c.kind === 'shell' && c.command?.segments === 1

/** 改走自建工具时 WouldRoute.to 的写法：custom_tool:<id> */
export const customRoute = (id: string) => `custom_tool:${id}`
export const routeToolId = (to: string) => (to.startsWith('custom_tool:') ? to.slice('custom_tool:'.length) : '')

/** UE 的编译程序：npm run build、cargo build 这类不归面板的编译申请 */
const UE_BUILD = /^(?:build|unrealbuildtool|ubt|runuat|msbuild|devenv)$/

const strip = (w: string) => w.replace(/^["']|["']$/g, '')

/**
 * Agent 拼的命令里交给这个工具查的文件：程序名后面不是开关的词，对得上工具 role.paths 的通配（没写 paths 时要像个文件名）。
 * 只看第一段（多段命令本来就不改道）
 */
export function commandFiles(command: string, tool: Pick<CustomToolSig, 'paths'>): string[] {
  const words = command.trim().split(/\s+/).map(strip).filter(Boolean)
  const res = (tool.paths ?? []).map((g) => globRe(g, { dirPrefix: true }))
  return words.slice(1).filter((w) => {
    if (w.startsWith('-') || w.includes('{{')) return false
    const p = w.replaceAll('\\', '/').replace(/^\.\//, '')
    return res.length ? res.some((re) => re.test(p)) : /\.[A-Za-z0-9]{1,8}$/.test(p)
  })
}

/** 面板能不能替 Agent 跑这个工具：只读、除文件外没有填不上的必填参数、要文件时命令里找得到文件 */
export function canServe(tool: CustomToolSig, call: ToolCall): boolean {
  if (tool.effect !== 'read' || tool.needsArgs) return false
  return !tool.fileParam || commandFiles(String(call.input.command ?? ''), tool).length > 0
}

export function verifyClaims(c: ToolCall, ctx: ClaimCtx): Claim | undefined {
  if (c.kind === 'panel' && c.panel === 'custom_tool') return { by: 'custom_tool' }
  if (c.kind !== 'shell' || !c.command) return undefined
  const prog = c.command.program
  const tool = ctx.customTools.find((x) => x.role !== 'build' && sigMatches(x, prog))
  if (tool && single(c))
    return { by: prog, route: { to: customRoute(tool.id), decision: canServe(tool, c) ? 'serve' : 'redirect' } }
  if (tool || (c.command.category === 'lint' && prog === 'luac')) return { by: prog }
  return undefined
}

export function applyClaims(c: ToolCall, ctx: ClaimCtx): Claim | undefined {
  if (c.kind === 'panel' && c.panel === 'request_build') return { by: 'request_build' }
  if (c.kind !== 'shell' || !c.command) return undefined
  const prog = c.command.program
  const builds = ctx.customTools.filter((x) => x.role === 'build')
  const own = builds.find((x) => sigMatches(x, prog))
  const ue = c.command.category === 'build' && UE_BUILD.test(prog)
  if (!own && !ue) return undefined
  if (!single(c)) return { by: prog }
  // UE 编译先走 request_build（同一编译目录同时只编一次，要排队）：它只在 UE 项目的对话里挂（父对话占位编译、子对话向父对话申请）。
  // 项目自己的编译脚本常常也叫 build.bat，和引擎的 Build.bat 认成同一个程序名，所以挂了 request_build 时它优先
  if (ue && ctx.build) return { by: prog, route: { to: 'request_build', decision: 'redirect' } }
  const tool = own ?? builds[0]
  return tool ? { by: prog, route: { to: customRoute(tool.id), decision: 'redirect' } } : { by: prog }
}
