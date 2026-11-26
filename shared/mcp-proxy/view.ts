/**
 * 「给 Agent 的工具」的视图（ADR 0085）：服务端接口和演示后端调同一份，开跑记录由调用方给（服务端是真实开跑时记下的，演示里写死几轮）
 */
import { CLIS } from '../clis.ts'
import type { ExposureView } from '../api-contract/mcp-proxy.ts'
import type { ExternalClaim } from './exposure.ts'
import type { ExposureRun } from './types.ts'

export function exposureView(enabled: boolean, runs: ExposureRun[], claims: readonly ExternalClaim[]): ExposureView {
  return {
    enabled,
    clis: CLIS.map((d) => ({ id: d.id, name: d.name, mcpOnlyPanel: !!d.takeover?.mcpOnlyPanel?.length })),
    claims: claims.map((c) => ({ capability: c.capability, use: c.use, tools: [...c.tools], by: c.by })),
    runs: [...runs].sort((a, b) => b.at - a.at),
  }
}
