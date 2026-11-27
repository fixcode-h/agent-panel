/**
 * CLI 定义里的 takeover（设计稿「技能与自建工具按情境加载」5.3）：这个 CLI 让工具网关接管调用能做到哪一步。
 * 代码按字段走，不按 CLI 名字分支；没实测过的 CLI 按保守值（不改写、能代答）。
 *
 * - rewrite：能把工具输入换掉后照常执行（CLI 和模型看到的是一次正常调用）。还要钩子定义里有改写的输出模板
 *   （hooks.events['tool.before'].rewrite），两样都有才改写；
 * - serve：拒绝说明能带结果（面板执行，结果交回）；
 * - hideBuiltin：能关掉自带的工具（Claude Code 的 --disallowedTools、Pi 的 --exclude-tools），第二期只登记；
 * - mcpOnlyPanel：能只用面板给的 MCP 服务，外部服务经面板代理时用（ADR 0085）；mcpOnlyArgs 是做到这一点的启动参数
 *   （Claude Code 的 --strict-mcp-config），开着代理、面板服务接上时才加；
 * - denyMark：CLI 把钩子拒绝说明交回时加在前面的字（正则，Claude Code 是「PreToolUse:Grep hook error: 」）。
 *   代答的结果走的是拒绝，CLI 会把这一行标成出错：面板按 SERVED_HEAD 认出是代答的，去掉这段字、不标红（servedResult）；
 * - tools：CLI 自带搜索工具的输入形状。grep 是 ripgrep 形状（pattern / path / glob / type / output_mode），
 *   glob 是按名字找文件（pattern / path）。没登记的自带搜索工具网关不接管
 */
import { z } from 'zod'

export const TAKEOVER_TOOL_SHAPES = ['grep', 'glob'] as const

export const CliTakeover = z.object({
  rewrite: z.boolean().default(false),
  serve: z.boolean().default(true),
  hideBuiltin: z.boolean().default(false),
  mcpOnlyPanel: z.boolean().default(false),
  mcpOnlyArgs: z.array(z.string()).default([]),
  denyMark: z.string().default(''),
  tools: z.record(z.string(), z.enum(TAKEOVER_TOOL_SHAPES)).default({}),
  why: z.string().default(''),
})
export type CliTakeover = z.infer<typeof CliTakeover>

export const DEFAULT_TAKEOVER: CliTakeover = CliTakeover.parse({})

/** 代答（拒绝说明里带结果）的开头：查找代答、校验代答都这样起头，工具行按它认出是面板给的结果、不是出错 */
export const SERVED_HEAD = '结果（面板）'

/**
 * CLI 报上来「出错」的工具结果是不是面板代答的：是的话去掉 CLI 加的拒绝前缀，交回正常的输出；不是返回 undefined。
 * 只认 SERVED_HEAD 起头的：守卫真拦下的（「【面板】……」）照样算出错
 */
export function servedResult(output: string, denyMark: string): string | undefined {
  let rest = output
  if (denyMark) {
    try {
      rest = output.replace(new RegExp(denyMark), '')
    } catch {
      // CLI 定义里的正则写错了：按没有前缀认
    }
  }
  return rest.startsWith(SERVED_HEAD) ? rest : undefined
}
