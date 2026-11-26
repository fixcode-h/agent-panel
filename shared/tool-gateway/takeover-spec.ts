/**
 * CLI 定义里的 takeover（设计稿「技能与自建工具按情境加载」5.3）：这个 CLI 让工具网关接管调用能做到哪一步。
 * 代码按字段走，不按 CLI 名字分支；没实测过的 CLI 按保守值（不改写、能代答）。
 *
 * - rewrite：能把工具输入换掉后照常执行（CLI 和模型看到的是一次正常调用）。还要钩子定义里有改写的输出模板
 *   （hooks.events['tool.before'].rewrite），两样都有才改写；
 * - serve：拒绝说明能带结果（面板执行，结果交回）；
 * - hideBuiltin：能关掉自带的工具（Claude Code 的 --disallowedTools、Pi 的 --exclude-tools），第二期只登记；
 * - mcpOnlyPanel：能只用面板给的 MCP 服务（Claude Code 的 --strict-mcp-config），外部服务经面板代理时用（ADR 0085）；
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
  tools: z.record(z.string(), z.enum(TAKEOVER_TOOL_SHAPES)).default({}),
  why: z.string().default(''),
})
export type CliTakeover = z.infer<typeof CliTakeover>

export const DEFAULT_TAKEOVER: CliTakeover = CliTakeover.parse({})
