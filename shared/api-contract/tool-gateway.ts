/**
 * 工具网关（ADR 0084）的接口契约：设置 →「Agent 工具」的调用记录、统计、网关模式和能力表。
 * 服务端 server/tool-gateway/api.ts，演示 web/src/lib/demo/demo-tool-gateway.ts；新记录经页面事件流（tool-call）推给页面
 */
import { z } from 'zod'
import { endpoint } from './define.ts'
import { GatewayStats } from '../tool-gateway/stats.ts'
import { CallRecord, CAPABILITY_IDS, GATEWAY_MODES } from '../tool-gateway/types.ts'

export const CallPage = z.object({
  items: z.array(CallRecord),
  total: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
  /** 记录里出现过的对话（筛选下拉用），新的在前 */
  tasks: z.array(z.object({ id: z.string(), title: z.string() })),
})
export type CallPage = z.infer<typeof CallPage>

export const GatewaySettingsView = z.object({
  mode: z.enum(GATEWAY_MODES),
  /** 按项目单独设的模式 */
  projects: z.record(z.string(), z.enum(GATEWAY_MODES)).default({}),
  modes: z.array(z.object({ id: z.enum(GATEWAY_MODES), label: z.string(), hint: z.string(), available: z.boolean() })),
})
export type GatewaySettingsView = z.infer<typeof GatewaySettingsView>

/** 能力表的一行：接管哪些调用、几条路和各自现在的状态（find 取能力路由的来源状态） */
export const CapabilityView = z.object({
  id: z.enum(CAPABILITY_IDS),
  label: z.string(),
  summary: z.string(),
  takes: z.array(z.string()),
  phase: z.number(),
  routes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      /** planned：这一期还没接上 */
      state: z.enum(['ready', 'starting', 'down', 'planned']),
      why: z.string().optional(),
    }),
  ),
  /** 最近的调用记录里归它的有几次、其中能改道的几次 */
  calls: z.number(),
  routable: z.number(),
})
export type CapabilityView = z.infer<typeof CapabilityView>

export const toolGatewayContract = {
  /** 查询参数：projectId、taskId、decision、capability、q、offset、limit */
  calls: endpoint({ method: 'GET', path: '/tool-gateway/calls', res: CallPage }),
  /** 查询参数：projectId、n（最近几条，默认 200） */
  stats: endpoint({ method: 'GET', path: '/tool-gateway/stats', res: GatewayStats }),
  settings: endpoint({ method: 'GET', path: '/tool-gateway/settings', res: GatewaySettingsView }),
  setSettings: endpoint({
    method: 'PUT',
    path: '/tool-gateway/settings',
    /** 改全局模式，或改某个项目的（mode 为 null 是回到跟随全局） */
    body: z.object({
      mode: z.enum(GATEWAY_MODES).optional(),
      project: z.object({ id: z.string().min(1), mode: z.enum(GATEWAY_MODES).nullable() }).optional(),
    }),
    res: GatewaySettingsView,
  }),
  /** 查询参数 projectId：查找的路按这个项目问（插件登记的路、项目接的服务） */
  capabilities: endpoint({ method: 'GET', path: '/tool-gateway/capabilities', res: z.array(CapabilityView) }),
}
