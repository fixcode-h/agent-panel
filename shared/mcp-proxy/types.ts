/**
 * 外部 MCP 服务代理（ADR 0085）前后端共用的形状：开跑时给 Agent 哪些工具（ExposurePolicy，./exposure.ts）、
 * 每个外部服务是经面板代理还是照旧直接挂在 CLI 上、哪些工具因为被能力接管没给。
 * 服务端在 server/mcp-proxy/，设置「Agent 工具 → 工具路由」的「给 Agent 的工具」显示的就是这份
 */
import { z } from 'zod'
import { t } from '../i18n.ts'
import { CAPABILITY_IDS } from '../tool-gateway/types.ts'

/** 一个外部服务这一轮怎么给：proxy 经面板代理（CLI 只挂面板）；direct 照旧把服务直接挂在 CLI 上 */
export const EXPOSURE_MODES = ['proxy', 'direct'] as const
export type ExposureMode = (typeof EXPOSURE_MODES)[number]

/**
 * 为什么这样给（一个原因一行，界面按它写人话；加原因只加一行）：
 * - proxied：正常代理；
 * - off：用户在设置里关了代理；
 * - cli：这个 CLI 不能只挂面板的服务（CLI 定义没有 takeover.mcpOnlyPanel），或不能把退回的服务按轮带上（mcpStore.inject）；
 * - no-panel：这一轮没有面板的工具服务（压缩、审查这类只挂提问工具的调用），没处转；
 * - unreachable：连不上 / 没在时限里答出工具表；
 * - protocol：服务的协议面板的客户端不支持（例如只有旧的 SSE）；
 * - failed：最近代理调用出过错，这段时间先退回直接挂
 */
export const EXPOSURE_WHYS = ['proxied', 'off', 'cli', 'no-panel', 'unreachable', 'protocol', 'failed'] as const
export type ExposureWhy = (typeof EXPOSURE_WHYS)[number]

export const EXPOSURE_WHY_TEXT: Record<ExposureWhy, () => string> = {
  proxied: () => t('经面板代理：调用都进调用记录，面板补参数、等索引'),
  off: () => t('设置里关了代理，照旧直接挂在 CLI 上'),
  cli: () => t('这个 CLI 不能只挂面板的服务，照旧直接挂'),
  'no-panel': () => t('这一轮没有面板的工具服务，照旧直接挂'),
  unreachable: () => t('面板连不上它，退回直接挂在 CLI 上'),
  protocol: () => t('面板的客户端不支持它的协议，退回直接挂在 CLI 上'),
  failed: () => t('最近代理调用出过错，先退回直接挂在 CLI 上'),
}

/** 一个外部工具：给没给 Agent；没给时是哪个能力接管的、Agent 该改用哪个面板工具 */
export const ExposedTool = z.object({
  name: z.string(),
  shown: z.boolean(),
  hiddenBy: z.object({ capability: z.enum(CAPABILITY_IDS), use: z.string(), by: z.string() }).optional(),
})
export type ExposedTool = z.infer<typeof ExposedTool>

export const ServerExposure = z.object({
  name: z.string(),
  /** 从哪读到的（.mcp.json、全局配置、按项目……），给人看 */
  source: z.string(),
  mode: z.enum(EXPOSURE_MODES),
  why: z.enum(EXPOSURE_WHYS),
  /** 连不上、协议不支持时的原话 */
  detail: z.string().optional(),
  /** 工具表；直接挂、没问到工具表时为空 */
  tools: z.array(ExposedTool),
})
export type ServerExposure = z.infer<typeof ServerExposure>

/** 一轮的结果：代理开没开、每个服务怎么给 */
export const ExposurePlan = z.object({
  /** 这一轮 CLI 是不是只挂了面板（有一个服务经代理） */
  proxy: z.boolean(),
  servers: z.array(ServerExposure),
})
export type ExposurePlan = z.infer<typeof ExposurePlan>

/** 设置页的一行：最近一次真实开跑时算出来的（哪个 CLI、哪个对话、什么时候） */
export const ExposureRun = z.object({
  projectId: z.string(),
  cli: z.string(),
  taskTitle: z.string(),
  at: z.number(),
  plan: ExposurePlan,
})
export type ExposureRun = z.infer<typeof ExposureRun>

/** 外部工具被能力接管的登记（./exposure.ts 的注册表）：设置页也列出来 */
export const ExternalClaimView = z.object({
  capability: z.enum(CAPABILITY_IDS),
  use: z.string(),
  tools: z.array(z.string()),
  by: z.string(),
})
export type ExternalClaimView = z.infer<typeof ExternalClaimView>
