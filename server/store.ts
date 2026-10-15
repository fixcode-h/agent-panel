import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Agent, type AgentInput } from '../shared/schema.ts'

const DATA_DIR = process.env.AGENT_PANEL_DATA ?? path.resolve('data')
const FILE = path.join(DATA_DIR, 'agents.json')

let cache: Agent[] | null = null
let writing = Promise.resolve()

async function load(): Promise<Agent[]> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8'))
    cache = Agent.array().parse(raw)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
    cache = []
  }
  return cache
}

/** 串行写入 + 先写临时文件再改名，避免并发写坏文件 */
function persist(agents: Agent[]) {
  cache = agents
  writing = writing.then(async () => {
    await mkdir(DATA_DIR, { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(agents, null, 2), 'utf8')
    await rename(tmp, FILE)
  })
  return writing
}

/** 始终保证：有 Agent 时恰好一个是主 Agent */
function normalizeMain(agents: Agent[], preferId?: string): Agent[] {
  if (agents.length === 0) return agents
  const mainId =
    (preferId && agents.some((a) => a.id === preferId) && preferId) ||
    agents.find((a) => a.role === 'main')?.id ||
    agents[0].id
  return agents.map((a) => ({ ...a, role: a.id === mainId ? 'main' : 'sub' }))
}

export const store = {
  list: load,

  async create(input: AgentInput) {
    const agents = await load()
    const now = new Date().toISOString()
    const agent: Agent = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    const next = normalizeMain([...agents, agent], input.role === 'main' ? agent.id : undefined)
    await persist(next)
    return next.find((a) => a.id === agent.id)!
  },

  async update(id: string, input: AgentInput) {
    const agents = await load()
    const old = agents.find((a) => a.id === id)
    if (!old) return null
    const updated: Agent = { ...old, ...input, id, updatedAt: new Date().toISOString() }
    let next = agents.map((a) => (a.id === id ? updated : a))
    // 把当前主 Agent 改成子 Agent 时，主 Agent 顺延给第一个其它 Agent
    if (old.role === 'main' && input.role === 'sub') {
      const fallback = next.find((a) => a.id !== id)
      next = normalizeMain(next, fallback?.id ?? id)
    } else {
      next = normalizeMain(next, input.role === 'main' ? id : undefined)
    }
    await persist(next)
    return next.find((a) => a.id === id)!
  },

  async setMain(id: string) {
    const agents = await load()
    if (!agents.some((a) => a.id === id)) return null
    const next = normalizeMain(agents, id)
    await persist(next)
    return next
  },

  async remove(id: string) {
    const agents = await load()
    if (!agents.some((a) => a.id === id)) return false
    await persist(normalizeMain(agents.filter((a) => a.id !== id)))
    return true
  },
}
