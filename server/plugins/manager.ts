import path from 'node:path'
import type { Agent, Project, ProjectCategory, Settings, Workflow } from '../../shared/schema.ts'
import type { BuiltinOps, BuiltinState } from '../../shared/builtin/install.ts'
import {
  addPluginContent,
  MOVED_TO_PLUGINS,
  planPluginRemoval,
  pluginKeys,
  type ContentKeys,
  type PluginRemoval,
} from '../../shared/builtin/plugin-content.ts'
import {
  pluginConfig,
  pluginEnabled,
  pluginOn,
  setEnabledPlugins,
  setInstalledPlugins,
} from '../../shared/plugins/index.ts'
import { removePluginSkills, setPluginSkillSources } from '../bundled-skills.ts'
import { clearSlashCache } from '../slash.ts'
import { log } from '../log.ts'
import { getSettings, saveSettings } from '../settings.ts'
import { DATA_DIR, writeJsonAtomic } from '../store.ts'
import { pluginConfigChanged, stopPlugin, syncRuntime } from './runtime.ts'
import { listInstalled, removePackage, rollbackPackage, type Installed } from './store.ts'

/**
 * 插件的装、删、开、关（ADR 0059）。核心数据（角色、工作流、项目）的读写由 server/index.ts 在启动时交进来，
 * 这里只按插件清单算该加什么、该删什么：
 * - 打开：插件的角色和工作流按「添加内置工作流」建出来，服务端入口启动；
 * - 关掉、删除：服务端停掉，没改过、没人用的角色和工作流副本删掉（先备份）、没改过的技能删掉，改过的和在用的留下并说明；
 * - 删除再多一步：删掉插件目录、插件自己的数据和设置里的参数。
 */
export interface PluginDeps {
  state: () => Promise<BuiltinState>
  projects: () => Promise<Project[]>
  categories: () => Promise<ProjectCategory[]>
  ops: BuiltinOps
  deleteAgent: (id: string) => Promise<unknown>
  deleteWorkflow: (id: string) => Promise<unknown>
}

let deps: PluginDeps | undefined // 模块状态：接线，启动时登记
let installed: Installed[] = [] // 模块状态：会话，跟着进程或连接一起没
let broken: { id: string; error: string }[] = [] // 模块状态：会话，跟着进程或连接一起没

export const installedList = () => installed
export const brokenList = () => broken
export const findInstalled = (id: string) => installed.find((p) => p.manifest.id === id)

/** 重读装着的插件，同步到共享层的列表、技能来源和运行中的服务端部分 */
export async function reloadPlugins() {
  const r = await listInstalled()
  installed = r.ok
  broken = r.broken
  setInstalledPlugins(installed.map((p) => p.manifest))
  setPluginSkillSources(installed.map((p) => ({ id: p.manifest.id, dir: p.dir, stamp: p.installedAt })))
  const s = await getSettings()
  setEnabledPlugins(s.plugins)
  // 插件带的「/」命令跟着装删换：菜单别用缓存里的旧列表
  clearSlashCache()
  await syncRuntime(
    installed,
    (id) => pluginOn(s.plugins, id),
    (id) => pluginConfig(getCachedPlugins(), id),
  )
}

/** 插件读参数时取最新的设置（保存设置后不用重启插件就能读到） */
let cachedPlugins: Settings['plugins'] | undefined // 模块状态：配置副本，重启时重读
const getCachedPlugins = () => cachedPlugins

async function backupRemoved(workflows: Workflow[], agents: Agent[], reason: string) {
  if (!workflows.length && !agents.length) return ''
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(DATA_DIR, 'backup', `removed-plugin-content-${stamp}.json`)
  await writeJsonAtomic(file, { reason, removedAt: new Date().toISOString(), workflows, agents })
  return file
}

/** 按 key 清副本：没改过、没人用的删（先备份），其余的留下并返回原因 */
async function removeContent(keys: ContentKeys, reason: string): Promise<PluginRemoval> {
  if (!deps) return { workflows: [], agents: [], kept: [] }
  const plan = planPluginRemoval(keys, await deps.state(), await deps.projects(), await deps.categories())
  if (plan.workflows.length || plan.agents.length) {
    const file = await backupRemoved(plan.workflows, plan.agents, reason)
    for (const w of plan.workflows) await deps.deleteWorkflow(w.id)
    for (const a of plan.agents) await deps.deleteAgent(a.id)
    log.info('plugin', reason, {
      workflows: plan.workflows.map((w) => w.name),
      agents: plan.agents.map((a) => a.name),
      backup: file,
    })
  }
  return plan
}

/** 插件关掉后要清的：角色、工作流副本和技能 */
async function turnOff(p: Installed, why: string) {
  await stopPlugin(p.manifest.id)
  const content = await removeContent(pluginKeys(p.manifest), why)
  const skills = await removePluginSkills(p.manifest.id)
  return { kept: content.kept, skillsKept: skills.kept }
}

async function turnOn(p: Installed) {
  if (!deps) return
  const r = await addPluginContent(p.manifest, await deps.state(), deps.ops)
  if (r.workflows.length || r.agents.length)
    log.info('plugin', `插件 ${p.manifest.name} 的内容已添加`, {
      workflows: r.workflows.map((w) => w.name),
      agents: r.agents.map((a) => a.name),
    })
}

/**
 * 启动时：先读装着的插件；关着的插件、以前内置现在挪进插件（插件没装或关着）的模板，本机没改过没人用的副本清掉。
 * 在内置模板安装（ensureProjectWorkflows）之前调用：开着的插件带的角色和工作流要算进内置列表
 */
export async function initPlugins(d: PluginDeps) {
  deps = d
  cachedPlugins = (await getSettings()).plugins
  await reloadPlugins()
}

/** 内置模板装完之后：清理关着的插件留下的副本 */
export async function cleanupDisabledPlugins() {
  for (const p of installed)
    if (!pluginEnabled(p.manifest.id))
      await removeContent(pluginKeys(p.manifest), `插件 ${p.manifest.name} 关着，已清掉它的内容`)
  for (const [id, keys] of Object.entries(MOVED_TO_PLUGINS))
    if (!pluginEnabled(id))
      await removeContent(keys, '以前内置、现在挪进插件的模板：插件没装或关着，已清掉没改过的副本')
}

/** 设置里插件的开关、参数变了（保存设置之后调用） */
export async function applyPluginSettings(prev: Settings['plugins'], next: Settings['plugins']) {
  cachedPlugins = next
  clearSlashCache()
  const result: Record<string, { kept: PluginRemoval['kept']; skillsKept: string[] }> = {}
  for (const p of installed) {
    const id = p.manifest.id
    const was = pluginOn(prev, id)
    const now = pluginOn(next, id)
    if (!was && now) await turnOn(p)
    else if (was && !now) result[id] = await turnOff(p, `插件 ${p.manifest.name} 已关掉，清掉它的内容`)
    else if (now && JSON.stringify(pluginConfig(prev, id)) !== JSON.stringify(pluginConfig(next, id)))
      await pluginConfigChanged(p, pluginConfig(next, id), () => pluginConfig(getCachedPlugins(), id))
  }
  await syncRuntime(
    installed,
    (id) => pluginOn(next, id),
    (id) => pluginConfig(getCachedPlugins(), id),
  )
  return result
}

/** 改一个插件的开关或参数：写进设置，再按变化处理 */
export async function updatePlugin(
  id: string,
  patch: { enabled?: boolean; config?: Record<string, string | number | boolean> },
) {
  const s = await getSettings()
  const prev = s.plugins
  const cur = prev[id] ?? { enabled: false, config: {} }
  const next = {
    ...prev,
    [id]: {
      enabled: patch.enabled ?? cur.enabled,
      config: patch.config ? { ...cur.config, ...patch.config } : cur.config,
    },
  }
  await saveSettings({ ...s, plugins: next })
  return applyPluginSettings(prev, next)
}

/** 删除插件：开着的先按关掉处理，再删目录、插件数据和设置里的记录 */
export async function uninstallPlugin(id: string) {
  const p = findInstalled(id)
  let out: { kept: PluginRemoval['kept']; skillsKept: string[] } = { kept: [], skillsKept: [] }
  if (p) out = await turnOff(p, `插件 ${p.manifest.name} 已删除，清掉它的内容`)
  else await stopPlugin(id)
  await removePackage(id)
  const s = await getSettings()
  if (s.plugins[id]) {
    const { [id]: _gone, ...rest } = s.plugins
    await saveSettings({ ...s, plugins: rest })
    cachedPlugins = rest
  }
  await reloadPlugins()
  log.info('plugin', `已删除插件 ${p?.manifest.name ?? id}`)
  return out
}

/** 装完、升级完：重读；开着的插件补上新版本多出来的角色和工作流 */
export async function afterInstall(id: string) {
  await reloadPlugins()
  const p = findInstalled(id)
  if (p && pluginEnabled(id)) await turnOn(p)
}

/** 退回上一版（插件框架改进 B4）：先停掉现在这版，换回上一版再按装完处理（开着的照常启动、补内容） */
export async function rollbackPlugin(id: string) {
  await stopPlugin(id)
  await rollbackPackage(id)
  await afterInstall(id)
  log.info('plugin', `插件 ${id} 已退回上一版`, { version: findInstalled(id)?.manifest.version })
}

/** 插件页上「关着时会留下什么」：关着的插件按现在的数据算一遍要保留的副本（只算不删） */
export async function keptPreview(id: string) {
  const p = findInstalled(id)
  if (!p || !deps) return []
  return planPluginRemoval(pluginKeys(p.manifest), await deps.state(), await deps.projects(), await deps.categories())
}
