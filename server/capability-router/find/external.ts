/**
 * 外部 MCP 服务上的查找路（插件登记的 ExternalFindSource，例如 VS 的 UEToVS、IDEA 的 lua_code）变成路由里的一条路：
 * 面板按工具名在能用的服务里找到它、自己当客户端去调，调用规矩全由面板填：
 * - JetBrains IDE：带 projectPath（面板挑过的）；报「定不了项目」时按工作目录从 IDE 已开的项目里挑一个，记住后重调一次；
 *   开了「仅路由器」（工具表里只有 execute_tool）时经它转调，命令写成「工具名 --参数 值」；
 * - 服务报「正在建索引」（EmmyLua 的 indexing）时在这里等，最多到路由给的期限。
 * 以前这些都写在提示词里让模型照做（ADR 0067 第 5 节那几次报错），现在模型看不到这些服务
 */
import type { ExternalFindSource, FindOutcome, FindRequest } from '../../../shared/capability-router/find/types.ts'
import { parseFindJson, relPath } from '../../../shared/capability-router/find/hits.ts'
import { openProjectsIn, pickIdeProject } from '../../../shared/mcp-catalog/ide-project.ts'
import { isJetBrainsServer } from '../../../shared/mcp-catalog/known-titles.ts'
import type { Readiness } from '../../../shared/capability-router/types.ts'
import { ideProjectOf, rememberIdeProject } from '../../mcp-catalog/ide-project.ts'
import { callMcpTool } from '../../mcp-client/pool.ts'
import type { RouteSource } from '../router.ts'
import type { RouteServer } from '../servers.ts'

const INDEX_WAIT_MS = 60_000

export interface FindCtx {
  projectId: string
  /** 工作目录、项目目录：挑 IDE 项目、把结果换成相对路径都用它 */
  dirs: string[]
}

/** 仅路由器模式下的一行命令：值有空格加引号，数组和对象传 JSON */
export function routerCommand(tool: string, args: Record<string, unknown>): string {
  const parts = [tool]
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    // 数组、对象原样写 JSON（IDE 按 JSON 认）；字符串有空格、引号才加引号
    if (typeof v !== 'string') parts.push(`--${k}`, JSON.stringify(v))
    else parts.push(`--${k}`, /[\s"']/.test(v) ? JSON.stringify(v) : v)
  }
  return parts.join(' ')
}

/** 这个服务上怎么调这个工具：直接有就直接调；JetBrains 开了仅路由器时经 execute_tool */
function howToCall(sv: RouteServer, tool: string): 'direct' | 'router' | undefined {
  if (sv.tools.includes(tool)) return 'direct'
  if (isJetBrainsServer(sv.name) && sv.tools.includes('execute_tool')) return 'router'
  return undefined
}

/** 工具返回里的错误码（EmmyLua / UEToVS 都是 {"error":"<code>","message":"…"}） */
const errorOf = (text: string): { code: string; message: string } | undefined => {
  try {
    const j = JSON.parse(text)
    if (j && typeof j.error === 'string') return { code: j.error, message: String(j.message ?? j.error) }
  } catch {
    // 不是 JSON：原文就是说明
  }
  return undefined
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
  })

async function callOnce(sv: RouteServer, spec: ExternalFindSource, args: Record<string, unknown>, ctx: FindCtx) {
  const how = howToCall(sv, spec.tool)!
  const ide = isJetBrainsServer(sv.name)
  const withPath =
    ide && ideProjectOf(ctx.projectId, sv.name) ? { ...args, projectPath: ideProjectOf(ctx.projectId, sv.name) } : args
  return how === 'direct'
    ? callMcpTool(sv.server, sv.cwd, spec.tool, withPath)
    : callMcpTool(sv.server, sv.cwd, 'execute_tool', { command: routerCommand(spec.tool, withPath) })
}

/** 调一次，处理「定不了项目」「正在建索引」；其余错误抛出 */
async function callTool(
  sv: RouteServer,
  spec: ExternalFindSource,
  args: Record<string, unknown>,
  ctx: FindCtx,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + INDEX_WAIT_MS
  let pickedOnce = false
  let waits = 0
  for (;;) {
    const r = await callOnce(sv, spec, args, ctx)
    if (!r.isError) return r.text
    const open = isJetBrainsServer(sv.name) ? openProjectsIn(r.text) : undefined
    if (open && !pickedOnce) {
      const pick = pickIdeProject(open, ctx.dirs)
      if (!pick.path) throw new Error(`IDE 开着几个项目，挑不出这个项目对应哪一个（${pick.candidates.join('、')}）`)
      rememberIdeProject(ctx.projectId, sv.name, pick.path)
      pickedOnce = true
      continue
    }
    const err = errorOf(r.text)
    if (err?.code === 'indexing' && Date.now() < deadline && !signal?.aborted) {
      // 先勤后疏：刚开 IDE 时常常一两秒就好
      await sleep(Math.min(2000, 300 * 2 ** waits++), signal)
      continue
    }
    throw new Error(err ? `${err.code}：${err.message}` : r.text.slice(0, 300) || '工具报错')
  }
}

export function externalSource(
  spec: ExternalFindSource,
  servers: RouteServer[],
  ctx: FindCtx,
): RouteSource<FindRequest, FindOutcome> {
  const sv = servers.find((s) => howToCall(s, spec.tool) === 'direct') ?? servers.find((s) => howToCall(s, spec.tool))
  return {
    id: spec.id,
    // 卡片上写「服务 · 工具」（idea · lua_code）：用户认的是 IDE / VS 和工具名，不是插件登记的 id
    label: sv ? `${sv.name} · ${spec.tool}` : spec.tool,
    via: 'mcp',
    rank: spec.rank,
    accepts: (req) => spec.kinds.includes(req.kind) && spec.langs.includes(req.lang) && spec.args(req) !== null,
    ready: (): Readiness =>
      sv ? { state: 'ready' } : { state: 'down', why: `没有接 ${spec.tool} 所在的服务（没装，或服务没开）` },
    run: async (req, signal) => {
      const text = await callTool(sv!, spec, spec.args(req)!, ctx, signal)
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`返回的不是 JSON：${text.slice(0, 200)}`)
      }
      if (spec.parse) {
        // 插件自己读的结果：路径照样换成相对项目根（插件不知道这一轮的工作目录）
        const out = spec.parse(json, req)
        return { ...out, hits: out.hits.map((h) => ({ ...h, file: relPath(h.file, ctx.dirs) })) }
      }
      const out = parseFindJson(json, req, ctx.dirs)
      if (!out) throw new Error('返回的形状认不出来')
      return out
    },
  }
}

/** 这条路查到了算不算够（不用文本再补）：插件说了算，没说时 symbol / outline / members / include 够、refs 和 text 不够 */
export const externalFinal = (spec: ExternalFindSource, req: FindRequest) =>
  spec.final ?? (req.kind !== 'refs' && req.kind !== 'text')
