/**
 * 能力表（设计稿「技能与自建工具按情境加载」6.2）：每个能力登记一行——叫什么、接管哪些调用（claims）、打开改道后改走哪。
 * 工具网关（server/tool-gateway/）按这张表推算「这次调用能改到哪」；新能力只加一行，网关不按能力名写分支。
 *
 * claims 只看认出来的调用（shared/tool-gateway/classify.ts 的 ToolCall），不看回复文字。返回：
 * - undefined：不归这个能力；
 * - { by }：归它（筛选、统计用），但现在没有别的路可走（例如 luac -p 而项目没有对应的自建工具）；
 * - { by, route }：打开改道时会改走 route.to，决定是 route.decision。
 * 多段命令（管道、&&）一律不改道：解析不准，宁可走原命令（设计稿 13.2）
 */
import { t } from '../i18n.ts'
import type { CustomToolSig } from '../custom-tools/match.ts'
import type { GatewayDecision, ToolCall } from '../tool-gateway/types.ts'
import type { CapabilityId } from './types.ts'
import { applyClaims, verifyClaims } from './verify-apply.ts'

/** 推算时用到的、调用以外的事实（由服务端按项目取好） */
export interface ClaimCtx {
  /** 这个项目能用的自建工具认得出的程序名 */
  customTools: CustomToolSig[]
  /** 这一轮挂没挂 request_build（UE 项目：父对话占位编译、子对话向父对话申请）；空或不写是没挂 */
  build?: '' | 'child' | 'parent'
}

export interface Claim {
  by: string
  route?: { to: string; decision: GatewayDecision }
}

export interface Capability {
  id: CapabilityId
  label: () => string
  /** 一句话说这个能力做什么（设置「工具路由」页） */
  summary: () => string
  /** 接管哪些调用（设置页只读显示，和 claims 同一份事实写成人话） */
  takes: string[]
  /** 第几期接上真的路（设置页标「第三期」） */
  phase: number
  claims(call: ToolCall, ctx: ClaimCtx): Claim | undefined
}

const single = (c: ToolCall) => c.kind === 'shell' && c.command?.segments === 1

/** 外部 MCP 服务上的查找工具（UEToVS、IDEA 的 lua_code、JetBrains 自带）：find 的路就是它们，直接调的改走 find 由面板挑 */
export const EXTERNAL_FIND_TOOLS = [
  'lua_code',
  'search_symbols',
  'search_lua',
  'search_lua_files',
  'get_lua_outline',
  'search_in_files_by_text',
  'search_in_files_by_regex',
  'find_files_by_name_keyword',
  'find_files_by_glob',
]

/** UE 的二进制资源：直接读只能读到乱码 */
const ASSET = /\.(uasset|umap)$/i

export const CAPABILITIES: Capability[] = [
  {
    id: 'find',
    label: () => t('查找'),
    summary: () => t('找文件、找符号、查引用。结果是「索引 + 原命令」的并集，不会比原命令少。'),
    takes: ['rg', 'grep', 'git grep', 'find -name', 'Select-String', 'findstr', 'Grep', 'Glob', ...EXTERNAL_FIND_TOOLS],
    phase: 2,
    claims(c) {
      if (c.kind === 'panel' && c.panel === 'find') return { by: 'find' }
      if (c.kind === 'shell' && c.command?.category === 'search')
        return single(c)
          ? { by: c.command.program, route: { to: 'find', decision: 'rewrite' } }
          : { by: c.command.program }
      if (c.kind === 'read' && c.search) return { by: c.tool, route: { to: 'find', decision: 'serve' } }
      if (c.kind === 'mcp' && c.mcpTool && EXTERNAL_FIND_TOOLS.includes(c.mcpTool))
        return { by: c.mcpTool, route: { to: 'find', decision: 'serve' } }
      return undefined
    },
  },
  {
    id: 'verify',
    label: () => t('校验'),
    summary: () => t('改完对得上的文件后面板自己跑检查，只把报错推给 Agent；Agent 自己跑同类命令时也改走这里。'),
    takes: ['luac -p', t('自建工具里程序名相同的命令'), t('自建工具 role.replaces 登记的程序')],
    phase: 3,
    claims: verifyClaims,
  },
  {
    id: 'read-asset',
    label: () => t('读资源'),
    summary: () => t('读 .uasset / .umap：编辑器开着在编辑器里读，没开时不开编辑器读文件。'),
    takes: ['Read *.uasset', 'cat *.umap', 'ue_asset'],
    phase: 4,
    claims(c) {
      if (c.kind === 'mcp' && c.mcpTool === 'ue_asset') return { by: 'ue_asset' }
      const reads = c.kind === 'read' || (single(c) && c.command?.category === 'read')
      if (!reads) return undefined
      const target =
        c.kind === 'read'
          ? c.paths
          : String(c.input.command ?? '')
              .split(/\s+/)
              .map((w) => w.replace(/^["']|["']$/g, ''))
      const hit = target.find((p) => ASSET.test(p))
      return hit ? { by: c.tool, route: { to: 'ue_asset', decision: 'serve' } } : undefined
    },
  },
  {
    id: 'apply',
    label: () => t('改动生效'),
    summary: () =>
      t('UE 的编译命令改用 request_build 或项目自己的编译工具；Live Coding、Lua 热重载等插件接口 22（第四期）再接。'),
    takes: ['Build.bat', 'UnrealBuildTool', 'RunUAT', 'msbuild', 'request_build', t('自建工具 role=build')],
    phase: 3,
    claims: applyClaims,
  },
]

/** 这次调用归哪个能力、能改到哪（第一个认领的说了算） */
export function claimOf(call: ToolCall, ctx: ClaimCtx): { capability: CapabilityId; claim: Claim } | undefined {
  for (const cap of CAPABILITIES) {
    const claim = cap.claims(call, ctx)
    if (claim) return { capability: cap.id, claim }
  }
  return undefined
}
