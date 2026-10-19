import { BUILTIN_WORKFLOWS } from '../shared/builtin/workflows.ts'
import { seedBuiltins, type BuiltinOps, type BuiltinState } from '../shared/builtin/install.ts'
import { log } from './log.ts'
import { dataPath, readJson, writeJsonAtomic } from './store.ts'

/**
 * 首次启动时把内置工作流和它们用到的 Agent 装进数据，不用自己去模板里找。
 * 装过哪些记在 config/builtin.json：已经装过的不再装（删掉了就是不要了），以后版本新增的内置工作流照样补上。
 */
const MARK = dataPath('config/builtin.json')

export async function seedBuiltinsOnce(state: () => Promise<BuiltinState>, ops: BuiltinOps) {
  if (process.env.AGENT_PANEL_NO_BUILTIN) return
  try {
    const raw = (await readJson(MARK)) as { seeded?: string[] } | undefined
    const seeded = new Set(Array.isArray(raw?.seeded) ? raw.seeded : [])
    const todo = BUILTIN_WORKFLOWS.filter((w) => !seeded.has(w.key))
    if (!todo.length) return
    const cur = await state()
    const before = cur.workflows.length
    const next = await seedBuiltins(cur, ops, todo)
    await writeJsonAtomic(MARK, { seeded: [...seeded, ...todo.map((w) => w.key)] })
    log.info('builtin', '已装上内置工作流', { workflows: next.workflows.length - before })
  } catch (e) {
    // 装不上不影响启动，下次启动再试
    log.warn('builtin', `装内置工作流失败：${(e as Error).message}`)
  }
}
