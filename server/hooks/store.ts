import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR, writeJsonAtomic } from '../store.ts'
import { HookDef, HooksData, type HookDefInput } from '../../shared/hook-defs.ts'
import { log } from '../log.ts'

/**
 * 钩子的存储（ADR 0049 第二期）：数据目录 config/hooks.json（内置钩子的开关 + 用户钩子的定义），
 * 命令钩子的脚本单独放 config/hooks/<id>.mjs，定义里也留一份原文（设置页编辑、导出都看定义）。
 * 放在 config/ 下：「数据」页的备份、导出按 config 一类带上（server/data.ts），不用另登记。
 * 只认这里的：项目仓库里的钩子文件不会自动生效，钩子能执行任意命令，只能是用户在设置页亲手建的
 */
const FILE = () => path.join(DATA_DIR, 'config', 'hooks.json')
export const hookScriptFile = (id: string) => path.join(DATA_DIR, 'config', 'hooks', `${id}.mjs`)

let cache: HooksData | undefined

export async function readHooks(): Promise<HooksData> {
  if (cache) return cache
  const text = await readFile(FILE(), 'utf8').catch(() => '')
  if (!text.trim()) return (cache = HooksData.parse({}))
  try {
    cache = HooksData.parse(JSON.parse(text))
  } catch (e) {
    // 文件坏了不让整个面板起不来：当成空的，日志里留一笔，用户在设置页能看到没有钩子
    log.warn('hooks', '钩子配置读不出来，按没有钩子处理', { error: (e as Error).message })
    cache = HooksData.parse({})
  }
  return cache
}

async function save(data: HooksData) {
  cache = data
  await writeJsonAtomic(FILE(), data)
}

/** 内置钩子开关：和默认值一样时不记，默认值以后改了能跟着走 */
export async function setBuiltin(id: string, on: boolean, defaultOn: boolean) {
  const cur = await readHooks()
  const builtins = { ...cur.builtins }
  if (on === defaultOn) delete builtins[id]
  else builtins[id] = on
  await save({ ...cur, builtins })
}

/** 新建或更新一个用户钩子（id 为空时新建）；命令钩子的脚本同时写到它自己的文件 */
export async function putHook(input: HookDefInput): Promise<HookDef> {
  const cur = await readHooks()
  const id = input.id || randomUUID().slice(0, 8)
  const def = HookDef.parse({ ...input, id, updatedAt: new Date().toISOString() })
  if (def.action.type === 'command') {
    await mkdir(path.dirname(hookScriptFile(id)), { recursive: true })
    await writeFile(hookScriptFile(id), def.action.script, 'utf8')
  } else await rm(hookScriptFile(id), { force: true })
  const hooks = cur.hooks.some((h) => h.id === id) ? cur.hooks.map((h) => (h.id === id ? def : h)) : [...cur.hooks, def]
  await save({ ...cur, hooks })
  return def
}

export async function deleteHook(id: string) {
  const cur = await readHooks()
  await save({ ...cur, hooks: cur.hooks.filter((h) => h.id !== id) })
  await rm(hookScriptFile(id), { force: true })
}

/** 拖动排序：按给的 id 顺序排，没列到的放最后（顺序决定说明拼接的先后） */
export async function orderHooks(ids: string[]) {
  const cur = await readHooks()
  const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length)
  await save({ ...cur, hooks: [...cur.hooks].sort((a, b) => rank(a.id) - rank(b.id)) })
}

/** 测试用：换数据目录后清掉缓存 */
export const resetHooksCache = () => void (cache = undefined)
