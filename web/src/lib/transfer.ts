import { z } from 'zod'
import { AgentInput, WorkflowInput, type Agent, type Workflow } from '@shared/schema'
import { api } from './api'

/**
 * 导出 / 导入工作流：连同它用到的 Agent 一起打成一个 JSON 文件，方便分享和在另一台机器上使用。
 * 导入时同名的 Agent 直接复用，没有的新建；工作流重名时加上「导入」后缀。
 */
const FORMAT = 'agent-panel/workflow'

const Bundle = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  workflow: z.unknown(),
  agents: z.array(z.object({ id: z.string() }).passthrough()),
})

export function workflowAgents(w: Workflow, agents: Agent[]) {
  const ids = new Set([w.mainAgentId, ...w.members.map((m) => m.agentId)])
  for (const f of w.flows) for (const n of f.nodes) if (n.agentId) ids.add(n.agentId)
  return agents.filter((a) => ids.has(a.id))
}

export function exportWorkflow(w: Workflow, agents: Agent[]) {
  const { id, createdAt, updatedAt, ...workflow } = w
  const bundle = {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    workflow,
    // 分类是本机的，导出时去掉
    agents: workflowAgents(w, agents).map(({ createdAt, updatedAt, categoryId, ...a }) => a),
  }
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${w.name.replace(/[\\/:*?"<>|]/g, '_') || 'workflow'}.agent-panel.json`
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function importWorkflow(text: string, agents: Agent[], workflows: Workflow[]) {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 文件')
  }
  const b = Bundle.safeParse(raw)
  if (!b.success) throw new Error('这不是 Agent 面板导出的工作流文件')

  // Agent：同名复用，否则新建；记下旧 id → 新 id
  const map = new Map<string, string>()
  const created: Agent[] = []
  for (const x of b.data.agents) {
    const input = AgentInput.safeParse({ ...x, categoryId: '' })
    if (!input.success) throw new Error(`文件里的 Agent「${String(x.name ?? x.id)}」格式不对`)
    const same = [...agents, ...created].find((a) => a.name === input.data.name)
    if (same) map.set(x.id, same.id)
    else {
      const a = await api.createAgent(input.data)
      created.push(a)
      map.set(x.id, a.id)
    }
  }
  const w = WorkflowInput.safeParse(b.data.workflow)
  if (!w.success) throw new Error('文件里的工作流格式不对')
  const re = (id: string) => (id ? (map.get(id) ?? '') : '')
  const names = new Set(workflows.map((x) => x.name))
  let name = w.data.name
  for (let i = 1; names.has(name); i++) name = `${w.data.name}（导入${i > 1 ? ` ${i}` : ''}）`
  const workflow = await api.createWorkflow({
    ...w.data,
    name,
    mainAgentId: re(w.data.mainAgentId),
    members: w.data.members.map((m) => ({ ...m, agentId: re(m.agentId) })).filter((m) => m.agentId),
    flows: w.data.flows.map((f) => ({ ...f, nodes: f.nodes.map((n) => ({ ...n, agentId: re(n.agentId) })) })),
  })
  return { workflow, created }
}
