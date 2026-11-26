/**
 * 能力路由（设计稿：designs/统一查找方式-设计稿.md 第 3、8 节）：同一件事有几条路可走时，由面板按「每条路现在能不能用」挑最好的一条，
 * 不行就往下一条，最后才兜底。Agent 和用户都不用知道走了哪条；走了哪条记进路由记录，排查时在设置页看。
 *
 * 为什么由面板选、不再写提示词教模型选（用户 2026-11-25）：IDEA 开着、lua_code 能用，模型照样 rg 搜 Lua 函数——
 * 提示词散在角色、工作流、Skill 里互相打架，弱模型守不住「先 A 后 B」，延迟加载的 MCP 工具它也懒得加载说明。
 *
 * 一个能力（Capability）= 请求的形状 + 结果怎么合；一条路（RouteSource）= 能不能用 + 怎么查。
 * 新能力只加类型和几条路，路由主流程（server/capability-router/router.ts）不按能力名写分支
 */
import type { CAPABILITY_IDS } from '../tool-gateway/types.ts'

/**
 * 现在有的能力：查找是第一个；校验、读资源、改动生效先登记「接管哪些调用」（shared/capability-router/capabilities.ts），
 * 工具网关的观察模式按它推算能改到哪，真正的路第三、四期再接（设计稿「技能与自建工具按情境加载」6.2）
 */
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** 这条路现在能不能用：只读路由维护的状态，不在查的时候现问 */
export type Readiness =
  | { state: 'ready' }
  /** 正在启动、建索引：预计多久能好（毫秒），路由在一分钟内能等到就等 */
  | { state: 'starting'; etaMs?: number; why: string }
  | { state: 'down'; why: string }

/** 一次路由走过的每条路：给记录和设置页看 */
export interface RouteStep {
  source: string
  outcome: 'used' | 'empty' | 'skipped' | 'failed'
  why?: string
  ms?: number
  hits?: number
}

/** 路由记录的一条：从哪个入口来、要什么、走过哪几条路、最后用了哪条 */
export interface RouteLogEntry {
  at: number
  capability: CapabilityId
  projectId: string
  taskId?: string
  /** 入口：面板工具（find）还是接管了哪条命令（第二期） */
  entry: string
  /** 一句话说清要什么，例如「Lua 引用 OnSellAll」 */
  what: string
  steps: RouteStep[]
  /** 最后给出结果的路；都没结果时为空 */
  served?: string
  ms: number
}
