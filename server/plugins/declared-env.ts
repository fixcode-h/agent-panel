import path from 'node:path'
import { pluginOn } from '../../shared/plugins/index.ts'
import { fillPlaceholders } from '../../shared/plugins/placeholders.ts'
import { reservedEnv } from '../../shared/plugins/runtime-schema.ts'
import { getSettings } from '../settings.ts'
import { installedList } from './manager.ts'
import { pluginGate } from './project-gate.ts'
import { placeholderVars } from './declared-resolve.ts'
import type { Installed } from './store.ts'

export { prependPath } from './declared-path.ts'

/**
 * 插件接口 11 的 env（含 PATH 前置）和 mcp 只在「这个插件对这一轮生效」时带：设置里开着、加载成功，
 * 按项目的插件还要这个项目在「能力」里打开了它（project-gate.ts 统一判断）。
 * env、mcp 每轮现取，关掉、删掉插件时没有要撤的东西
 */
export async function activePlugins(projectId: string | undefined): Promise<Installed[]> {
  const out: Installed[] = []
  for (const p of await enabledPlugins()) if ((await pluginGate(p.manifest.id, projectId)).on) out.push(p)
  return out
}

/** 设置里开着、加载成功的插件（不看项目） */
export async function enabledPlugins(): Promise<Installed[]> {
  const s = await getSettings()
  return installedList().filter((p) => pluginOn(s.plugins, p.manifest.id))
}

export interface PluginRunEnv {
  /** 普通变量：放在账号设置的变量前面，同名时账号设置的赢（插件不覆盖用户的配置） */
  vars: { key: string; value: string }[]
  /** 前置到 PATH 的绝对目录（插件包里的），按插件顺序 */
  pathPrepend: string[]
}

/** 这一轮交给 CLI 的插件环境变量 */
export async function pluginEnvForRun(projectId: string | undefined): Promise<PluginRunEnv> {
  const out: PluginRunEnv = { vars: [], pathPrepend: [] }
  const seen = new Set<string>()
  for (const p of await activePlugins(projectId)) {
    const vars = await placeholderVars(p)
    for (const [key, v] of Object.entries(p.manifest.env)) {
      if (typeof v !== 'string') {
        out.pathPrepend.push(...v.prepend.map((d) => path.join(p.dir, d)))
        continue
      }
      // 清单校验已经拦过；这里再挡一次，防止旧数据或链接目录里改过的清单绕过
      if (reservedEnv(key) || seen.has(key)) continue
      seen.add(key)
      out.vars.push({ key, value: fillPlaceholders(v, vars) })
    }
  }
  return out
}
