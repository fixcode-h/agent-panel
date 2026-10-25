import { readFile } from 'node:fs/promises'
import { dataPath, writeJsonAtomic } from './store.ts'

/**
 * 已经自动装过的自带工作流（key）：自带工作流启动时默认全部加入，装过一次的记在这里，
 * 用户删掉的就不会在下次启动时又装回来（见 shared/builtin/install.ts 的 seedProjectWorkflows）。
 */
const FILE = dataPath('config/builtin-workflows.json')

export async function loadSeededWorkflows(): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8')) as { seeded?: unknown }
    return Array.isArray(raw.seeded) ? raw.seeded.filter((k): k is string => typeof k === 'string') : []
  } catch {
    // 第一次启动（或升级前）没有这个文件：自带工作流全部装一次
    return []
  }
}

export async function saveSeededWorkflows(seeded: string[]) {
  await writeJsonAtomic(FILE, { seeded })
}
