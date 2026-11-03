/**
 * 面板工具 start_workflow（ADR 0044）：父对话在自己下面开一个工作流子对话。
 * 调用拆在这里，orch-mcp.ts 到了行数上限；工具定义还在 orch-mcp.ts 的工具表里，和别的父对话工具放在一起
 */
import type { Orchestra, RouteInput } from '../shared/engine.ts'
import { clip } from '../shared/text.ts'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const out = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError && { isError }) })

/**
 * 执行一次 start_workflow：先按 id / 名字认出工作流（认不出就列出能用的），
 * 不带 again 时开新的工作流子对话（和 create_conversation 同一条路，计划里的等待、分诊卡都一样）；
 * 带 again 时把同一个工作流在那个子对话里再跑一次（和 send_to_conversation 同一条路）
 */
export async function callStartWorkflow(o: Orchestra, a: Record<string, unknown> | undefined, route?: RouteInput) {
  const input = str(a?.input).trim()
  if (!input) return out('input 是空的：写清楚这次要做什么、范围和验收标准', true)
  const again = str(a?.again).trim()
  const step = str(a?.step).trim()
  if (again) {
    const r = await o.sendToConversation(again, input, step, route, true)
    return out(r.info, !r.ok)
  }
  const picked = o.pickWorkflow(str(a?.workflow))
  if (!picked.ok) return out(picked.info, true)
  const flow = { ...picked.flow, input }
  const title = str(a?.title).trim() || `${flow.workflowName}：${clip(input.replace(/\s+/g, ' '), 24)}`
  const files = Array.isArray(a?.files) ? a.files.map(String).filter(Boolean) : undefined
  const r = await o.createConversation(title, input, files, step, { route, flow })
  return out(r.id ? `${r.info}（id: ${r.id}）` : r.info, !r.ok)
}
