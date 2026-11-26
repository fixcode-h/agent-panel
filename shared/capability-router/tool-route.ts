/**
 * 一次工具调用最终实际走的路（ToolUse.route）：对话里的工具卡片在耗时旁画一个小标（「查找 text · 面板按文本找」），
 * 点开看路由步骤（跳过了哪条、为什么、各自多久）。
 *
 * 为什么存在 ToolUse 上（AGENTS.md「Task 上只放要存盘的数据」）：它是这次调用的事实记录，和 knowledge 一样事后回看要用，
 * 重开页面、重启面板后还得在；不是运行时状态。只放显示要的几样，原始路由记录另在 logs/ 里（server/capability-router/log.ts）。
 *
 * 现在只有面板的 find 工具写它（能力路由的结果、找文件走文件索引）；以后工具网关改写 / 代答的调用也写同一个字段，
 * 用 from 写原来要调的（「面板改走 find · lua_code」）。观察模式下网关只推算、不改，不写这个字段，推算结果只在调用记录里
 */
import { z } from 'zod'

/** 一条路：给人看的名字，和它是外部 MCP 服务上的工具还是面板自带的 */
export const RouteHop = z.object({
  /** 路的编号（插件登记的 id、panel.text、panel.files），排查时对得上路由记录 */
  source: z.string(),
  /** 显示名，例如「idea · lua_code」「面板按文本找」「文件索引」 */
  label: z.string(),
  via: z.enum(['mcp', 'panel']),
})
export type RouteHop = z.infer<typeof RouteHop>

export const ToolRoute = z.object({
  /** 哪个能力（find……），对应 shared/capability-router/capabilities.ts */
  capability: z.string(),
  /** 最后给出结果的几条路（按走的先后；查引用时外部和文本会合并）；都没查到时为空 */
  served: z.array(RouteHop),
  /** 走过的每条路：用了、查回来是空的、跳过（为什么）、出错（为什么），各自多久 */
  steps: z.array(
    RouteHop.extend({
      outcome: z.enum(['used', 'empty', 'skipped', 'failed']),
      why: z.string().optional(),
      ms: z.number().optional(),
    }),
  ),
  /** 整次路由多久（毫秒） */
  ms: z.number().optional(),
  /** 网关改写 / 代答时，Agent 原来要调的（例如「rg -n Foo」）；Agent 直接调面板工具时没有 */
  from: z.string().optional(),
})
export type ToolRoute = z.infer<typeof ToolRoute>
