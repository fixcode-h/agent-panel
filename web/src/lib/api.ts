import type { Agent, AgentInput, CliStatus } from '@shared/schema'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `请求失败（${res.status}）`)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  clis: (refresh = false) => request<CliStatus[]>(`/clis${refresh ? '?refresh=1' : ''}`),
  agents: () => request<Agent[]>('/agents'),
  createAgent: (input: AgentInput) =>
    request<Agent>('/agents', { method: 'POST', body: JSON.stringify(input) }),
  updateAgent: (id: string, input: AgentInput) =>
    request<Agent>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  setMain: (id: string) => request<Agent[]>(`/agents/${id}/main`, { method: 'POST' }),
  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
}
