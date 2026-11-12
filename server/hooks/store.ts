import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR, writeJsonAtomic } from '../store.ts'
import { HookDef, HooksData, type HookDefInput, type HookEventName } from '../../shared/hook-defs.ts'
import { BUILTIN_HOOKS, tierDefault, type HookTier } from '../../shared/hook-builtins.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'

/**
 * 钩子的存储（ADR 0049 第二期）：数据目录 config/hooks.json（内置钩子的开关 + 用户钩子的定义），
 * 命令钩子的脚本单独放 config/hooks/<id>.mjs，定义里也留一份原文（设置页编辑、导出都看定义）。
 * 放在 config/ 下：「数据」页的备份、导出按 config 一类带上（server/data.ts），不用另登记。
 * 只认这里的：项目仓库里的钩子文件不会自动生效，钩子能执行任意命令，只能是用户在设置页亲手建的
 */
const FILE = () => path.join(DATA_DIR, 'config', 'hooks.json')
export const hookScriptFile = (id: string) => path.join(DATA_DIR, 'config', 'hooks', `${id}.mjs`)

let cache: HooksData | undefined // 模块状态：缓存，丢了重算

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

/**
 * 内置钩子（和插件钩子）的全局开关：和默认值一样时不记，默认值以后改了能跟着走。
 * 内置钩子的默认值是全局档位下该有的值（不传 defaultOn 时按档位算），插件钩子默认开
 */
export async function setBuiltin(id: string, on: boolean, defaultOn?: boolean) {
  const cur = await readHooks()
  const h = BUILTIN_HOOKS.find((x) => x.id === id)
  const def = defaultOn ?? (h ? tierDefault(cur, h) : true)
  const builtins = { ...cur.builtins }
  if (on === def) delete builtins[id]
  else builtins[id] = on
  await save({ ...cur, builtins })
}

const isBuiltinKey = (k: string) => BUILTIN_HOOKS.some((h) => h.id === k)

/**
 * 选档位：选了就是「回到这一档的标准配置」，所以这一层逐个改过的内置钩子开关一起清掉；
 * 插件钩子的开关也存在 builtins 里（键 plugin:…），不受档位管，留着。
 * projectId 给了是这个项目的档位，tier 为 null 表示不单独选、跟着全局
 */
export async function setTier(tier: HookTier | null, projectId = '') {
  const cur = await readHooks()
  if (!projectId) {
    const builtins = Object.fromEntries(Object.entries(cur.builtins).filter(([k]) => !isBuiltinKey(k)))
    await save({ ...cur, tier: tier ?? 'standard', builtins })
    return
  }
  const projectTiers = { ...cur.projectTiers }
  if (tier) projectTiers[projectId] = tier
  else delete projectTiers[projectId]
  const projects = { ...cur.projects }
  delete projects[projectId]
  await save({ ...cur, projectTiers, projects })
}

/** 按项目的内置钩子开关：on 为 null 时去掉这个项目的设置，回到跟着全局 */
export async function setProjectBuiltin(projectId: string, id: string, on: boolean | null) {
  const cur = await readHooks()
  const mine = { ...(cur.projects[projectId] ?? {}) }
  if (on === null) delete mine[id]
  else mine[id] = on
  const projects = { ...cur.projects }
  if (Object.keys(mine).length) projects[projectId] = mine
  else delete projects[projectId]
  await save({ ...cur, projects })
}

/** 按 CLI 关掉的事件：空数组时去掉这一项 */
export async function setCliOff(cli: string, events: HookEventName[]) {
  const cur = await readHooks()
  const cliOff = { ...cur.cliOff }
  if (events.length) cliOff[cli] = [...new Set(events)]
  else delete cliOff[cli]
  await save({ ...cur, cliOff })
}

/** 内置钩子的参数：和默认值一样时不记（默认值以后改了能跟着走） */
export async function setBuiltinParam(id: string, key: string, value: string[] | number, isDefault: boolean) {
  const cur = await readHooks()
  const mine = { ...(cur.params[id] ?? {}) }
  if (isDefault) delete mine[key]
  else mine[key] = value
  const params = { ...cur.params }
  if (Object.keys(mine).length) params[id] = mine
  else delete params[id]
  await save({ ...cur, params })
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

/**
 * 设置里原来的「计划 Webhook」（Settings.webhook）迁成 schedule.finished 上的一个 HTTP 钩子（ADR 0049 第三期）：
 * 只迁一次（hooks.json 里记 migrated.webhook），开关照原样；没填地址的不建。设置里的旧字段留着不删，降级回老版本还能用
 */
export async function migrateWebhook(old: { enabled: boolean; url: string }) {
  const cur = await readHooks()
  if (cur.migrated.webhook) return
  const url = old.url.trim()
  if (/^https?:\/\//.test(url))
    await putHook({
      name: t('计划任务 Webhook'),
      description: t('从设置里原来的「计划 Webhook」迁过来：计划任务跑完时把结果 POST 到这个地址'),
      event: 'schedule.finished',
      action: { type: 'http', url },
      enabled: old.enabled,
    })
  const now = await readHooks()
  await save({ ...now, migrated: { ...now.migrated, webhook: true } })
}
