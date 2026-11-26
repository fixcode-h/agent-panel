/**
 * 面板代 Agent 调一个别家 MCP 工具时要补的规矩（能力路由的查找路 server/capability-router/find/external.ts、
 * 外部服务代理 server/mcp-proxy/ 共用这一份，ADR 0081、0085）：
 * - JetBrains IDE：带 projectPath（面板挑过的）；报「定不了项目」时按工作目录从 IDE 已开的项目里挑一个，记住后重调一次；
 *   开了「仅路由器」（工具表里只有 execute_tool）时经它转调，命令写成「工具名 --参数 值」；
 * - 服务报「正在建索引」（EmmyLua 的 indexing）时在这里等，最多到期限。
 * 以前这些都写在提示词里让模型照做（ADR 0067 第 5 节那几次报错），现在由面板补
 */
import { openProjectsIn, pickIdeProject } from '../../shared/mcp-catalog/ide-project.ts'
import { isJetBrainsServer } from '../../shared/mcp-catalog/known-titles.ts'
import type { McpServer } from '../../shared/library.ts'
import { ideProjectOf, rememberIdeProject } from '../mcp-catalog/ide-project.ts'
import { callMcpTool } from './pool.ts'
import type { McpCallResult } from './session.ts'

export const INDEX_WAIT_MS = 60_000

/** 一个能调的别家服务：配置、起 stdio 用的目录、工具表里的名字 */
export interface CallableServer {
  name: string
  server: McpServer
  cwd: string
  tools: string[]
}

export interface CallCtx {
  projectId: string
  /** 工作目录、项目目录：挑 IDE 项目用 */
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
export function howToCall(sv: CallableServer, tool: string): 'direct' | 'router' | undefined {
  if (sv.tools.includes(tool)) return 'direct'
  if (isJetBrainsServer(sv.name) && sv.tools.includes('execute_tool')) return 'router'
  return undefined
}

/** 工具返回里的错误码（EmmyLua / UEToVS 都是 {"error":"<code>","message":"…"}） */
export const errorOf = (text: string): { code: string; message: string } | undefined => {
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

function callOnce(sv: CallableServer, tool: string, args: Record<string, unknown>, ctx: CallCtx) {
  const how = howToCall(sv, tool) ?? 'direct'
  const picked = isJetBrainsServer(sv.name) ? ideProjectOf(ctx.projectId, sv.name) : undefined
  const withPath = picked && args.projectPath === undefined ? { ...args, projectPath: picked } : args
  return how === 'direct'
    ? callMcpTool(sv.server, sv.cwd, tool, withPath)
    : callMcpTool(sv.server, sv.cwd, 'execute_tool', { command: routerCommand(tool, withPath) })
}

/**
 * 调一次，处理「定不了项目」「正在建索引」后返回工具最后的结果（可能 isError，原文交给调用方）；
 * 连不上、断了、超时抛出（调用方按「这个服务用不了」处理）
 */
export async function callExternalTool(
  sv: CallableServer,
  tool: string,
  args: Record<string, unknown>,
  ctx: CallCtx,
  signal?: AbortSignal,
  waitMs = INDEX_WAIT_MS,
): Promise<McpCallResult & { waitedIndex?: boolean }> {
  const deadline = Date.now() + waitMs
  let pickedOnce = false
  let waits = 0
  for (;;) {
    const r = await callOnce(sv, tool, args, ctx)
    if (!r.isError) return r
    const open = isJetBrainsServer(sv.name) ? openProjectsIn(r.text) : undefined
    if (open && !pickedOnce) {
      const pick = pickIdeProject(open, ctx.dirs)
      if (!pick.path)
        return {
          isError: true,
          text: `IDE 开着几个项目，挑不出这个项目对应哪一个（${pick.candidates.join('、')}）：请用户在 IDE 里只开这个项目，或在参数里写 projectPath。`,
        }
      rememberIdeProject(ctx.projectId, sv.name, pick.path)
      pickedOnce = true
      continue
    }
    const err = errorOf(r.text)
    if (err?.code === 'indexing') {
      if (Date.now() < deadline && !signal?.aborted) {
        // 先勤后疏：刚开 IDE 时常常一两秒就好
        await sleep(Math.min(2000, 300 * 2 ** waits++), signal)
        continue
      }
      return { ...r, waitedIndex: true }
    }
    return r
  }
}
