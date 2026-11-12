import { z } from 'zod'
import { ArgRule } from '../arg-rule.ts'

/**
 * 从 CLI 自己问出它能用的「/」命令（Pi 的 get_commands，ADR 0050 第四期）：插件注册的命令、插件包里带的提示词模板和 Skill
 * 面板扫目录看不到，只能问它。起一次 CLI（args，参数规则照常用 trust=approve 等条件），发 request，
 * 在回复的 list 路径下取列表，每项按下面的字段取名字、说明、种类和文件路径。
 * kinds 把 CLI 的种类映射成面板的：command（命令模板，面板按文件展开）、skill（面板按 SKILL.md 展开）、
 * native（只有 CLI 自己能执行的命令，原样交给它，见 server/slash.ts）。namePrefix 是 CLI 给某类命令名字加的前缀，去掉后再用
 */
export const CommandsQuery = z.object({
  args: z.array(ArgRule).default([]),
  request: z.record(z.string(), z.unknown()),
  list: z.string(),
  name: z.string().default('name'),
  description: z.string().default('description'),
  kind: z.string().default('source'),
  path: z.string().default(''),
  kinds: z.record(z.string(), z.enum(['command', 'skill', 'native'])).default({}),
  namePrefix: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(20_000),
})
export type CommandsQuery = z.infer<typeof CommandsQuery>

/**
 * 发出去的那句被 CLI 当命令自己处理了、不一定开新的一轮（Pi 的扩展命令回 disposition=handled）：
 * 回复里 at 路径的值等于 value 时，等 graceMs 还没收到 started 那样的记录，就当这一轮结束；收到了照常等结束记录
 */
export const HandledReply = z.object({
  save: z.string(),
  at: z.string(),
  value: z.unknown(),
  started: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  graceMs: z.number().int().positive().default(3000),
})
export type HandledReply = z.infer<typeof HandledReply>
