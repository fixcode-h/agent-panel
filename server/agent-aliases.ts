import { readFileSync } from 'node:fs'
import path from 'node:path'
import { setAgentAliases, type Agent } from '../shared/schema.ts'
import { dataPath, writeJsonAtomic } from './store.ts'

/**
 * 被删掉的角色 id → 该转到的角色 id（合并掉的内置角色删掉后登记在这里）。
 * 旧对话、旧工作流快照里还记着旧 id，读出来时按它改写（见 shared/schema.ts 的 setAgentAliases），
 * 所以要在读任何数据之前先装上。
 */
const FILE = dataPath('config/agent-aliases.json')

let current: Record<string, string> = {}

export function loadAgentAliases() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      current = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<
        string,
        string
      >
  } catch {
    // 还没有删过角色，没有这个文件
  }
  setAgentAliases(current)
}

/** 登记新删掉的角色；以前登记过、指向这次被删掉的角色的，一起改指到新的目标，不会转到一个已经不存在的 id */
export async function addAgentAliases(map: Record<string, string>) {
  if (!Object.keys(map).length) return
  const next = { ...current, ...map }
  for (const [from, to] of Object.entries(next)) if (to in map) next[from] = map[to]
  current = next
  setAgentAliases(current)
  await writeJsonAtomic(FILE, current)
}

/** 删掉的角色原样备份一份：用户自己调过的设定还能找回来 */
export async function backupRemovedAgents(list: Agent[], reason: string) {
  if (!list.length) return ''
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(path.dirname(FILE), 'backup', `removed-agents-${stamp}.json`)
  await writeJsonAtomic(file, { reason, removedAt: new Date().toISOString(), agents: list })
  return file
}
