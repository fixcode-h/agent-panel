import type { Project } from '../../shared/schema.ts'
import type { PluginManifest } from '../../shared/plugins/types.ts'
import { pluginOnFor, toggleCapability, type ProjectCapabilities } from '../../shared/projects/capabilities.ts'
import { t } from '../../shared/i18n.ts'
import type { PluginProjects } from './sdk.ts'

/**
 * 项目能力的把关（插件接口 9，设计稿：Agent侧栏与项目管理重设计 第 6 节）：按项目生效的插件
 * （清单 activation = project）只在项目「能力」里打开了的项目挂工具。全局关掉的插件根本没在运行，不归这里管。
 * 只在这一处判断，插件里不用再各自看项目。
 *
 * 读写项目、查清单的接线由 manager.ts 在 initPlugins 时登记（configureProjectGate）：这里不反过来 import manager，
 * 免得 runtime → 这里 → manager → runtime 绕成环、改变模块初始化顺序
 */
interface GateWiring {
  projects: () => Promise<Project[]>
  manifest: (id: string) => PluginManifest | undefined
  setCapabilities: (projectId: string, caps: ProjectCapabilities) => Promise<void>
}
let wiring: GateWiring | undefined // 模块状态：接线，启动时登记

export function configureProjectGate(w: GateWiring) {
  wiring = w
}

async function projectOf(projectId: string | undefined): Promise<Project | undefined> {
  if (!projectId) return undefined
  return (await wiring?.projects())?.find((p) => p.id === projectId)
}

/** 这一轮（这个项目）能不能用这个插件；不能时给出自检里显示的原因 */
export async function pluginGate(id: string, projectId: string | undefined): Promise<{ on: boolean; reason?: string }> {
  const m = wiring?.manifest(id)
  if (!m || m.activation !== 'project') return { on: true }
  const project = await projectOf(projectId)
  if (pluginOnFor(project, id, m.activation)) return { on: true }
  return {
    on: false,
    reason: project
      ? t('这个项目没有打开「{name}」：在项目设置 →「能力」里打开', { name: m.name })
      : t('「{name}」只在打开了它的项目里生效', { name: m.name }),
  }
}

/** 给插件的 PluginServerContext.projects：只能开关自己 */
export function pluginProjectsApi(id: string): PluginProjects {
  return {
    enabled: async (projectId) => {
      const m = wiring?.manifest(id)
      return pluginOnFor(await projectOf(projectId), id, m?.activation)
    },
    enable: async (projectId, on = true) => {
      const d = wiring
      const project = await projectOf(projectId)
      if (!d || !project) throw new Error(t('没有这个项目：{id}', { id: projectId }))
      const next = toggleCapability(project.capabilities, 'plugins', id, on)
      if (next.plugins.join() === (project.capabilities?.plugins ?? []).join()) return
      await d.setCapabilities(projectId, next)
    },
  }
}
