import type { Project, TestStep } from '../schema.ts'
import { activePlugins, activePluginConfig } from './index.ts'

export * from './contrib-schema.ts'

/**
 * 插件清单里的三段扩展（插件接口 3）：钩子、测试步骤、「/」命令。插件打开时装进面板已有的三套机制，
 * 关掉、删除时一起撤掉——三处都是用到时按「现在开着的插件」现取，不往钩子数据、项目设置、命令目录里写副本，
 * 所以关插件不用另外清理，也不会留下孤儿。
 */

/** 面板里插件钩子、测试步骤的 id：plugin:<插件 id>:<清单里的 id> */
export const pluginItemId = (pluginId: string, localId: string) => `plugin:${pluginId}:${localId}`

/** 这条测试步骤是哪个插件带来的（不是插件的返回空） */
export function stepPluginId(step: Pick<TestStep, 'id'>) {
  const m = /^plugin:([a-z][a-z0-9-]*):/.exec(step.id)
  return m?.[1] ?? ''
}

/** 命令里的 {config.key} 换成插件参数的值；参数没有的保留原样，Agent 看到会知道要去配 */
export function fillConfig(command: string, config: Record<string, string | number | boolean>) {
  return command.replace(/\{config\.([\w-]+)\}/g, (all, k: string) =>
    config[k] === undefined || config[k] === '' ? all : String(config[k]),
  )
}

/**
 * 项目根目录里有没有匹配这些 glob 的文件：服务端注入（要读磁盘），网页和单测不注入时当作有——
 * 界面上列出来照实写「只在有 X 的项目里生效」，不在前端猜
 */
type Probe = (dir: string, globs: string[]) => boolean
let probe: Probe = () => true // 模块状态：接线，启动时登记
export const setProjectProbe = (p: Probe) => void (probe = p)

/**
 * 开着的插件给这个项目带来的测试步骤（已换好参数、id 加了插件前缀）。
 * 排在项目自己的步骤后面；项目设置里关掉的（pluginStepsOff）、detect 对不上的不算
 */
export function pluginTestSteps(project: Partial<Pick<Project, 'path' | 'pluginStepsOff'>>): TestStep[] {
  const off = new Set(project.pluginStepsOff ?? [])
  return activePlugins().flatMap((p) =>
    (p.testSteps ?? []).flatMap((s): TestStep[] => {
      const id = pluginItemId(p.id, s.id)
      if (off.has(id)) return []
      if (s.detect.length && !(project.path && probe(project.path, s.detect))) return []
      const { detect: _d, ...step } = s
      return [{ ...step, id, command: fillConfig(step.command, activePluginConfig(p.id)) }]
    }),
  )
}
