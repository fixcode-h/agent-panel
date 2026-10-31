import { dataPath, readJson, writeJsonAtomic } from './store.ts'

/**
 * 已经自动装过的自带工作流（key）：自带工作流启动时默认全部加入，装过一次的记在这里，
 * 用户删掉的就不会在下次启动时又装回来（见 shared/builtin/install.ts 的 seedProjectWorkflows）。
 */
const FILE = dataPath('config/builtin-workflows.json')

export async function loadSeededWorkflows(): Promise<string[]> {
  // 第一次启动（或升级前）没有这个文件、或者文件坏了：都当作没装过，全部装一次。
  // 坏文件由 readJson 归档到 broken/，不会让启动失败
  const raw = (await readJson(FILE).catch(() => undefined)) as { seeded?: unknown } | undefined
  const seeded = raw?.seeded
  return Array.isArray(seeded) ? seeded.filter((k): k is string => typeof k === 'string') : []
}

export async function saveSeededWorkflows(seeded: string[]) {
  await writeJsonAtomic(FILE, { seeded })
}
