import { z } from 'zod'

/**
 * 项目能力（设计稿：Agent侧栏与项目管理重设计 第 6 节）：这个项目打开了哪些「按项目生效」的能力。
 *
 * 插件在清单里写生效方式（PluginManifest.activation）：
 * - global：装好就对所有项目、所有对话生效，项目里没有开关，这里也不记；
 * - project：只在这里打开了的项目里生效（挂工具、项目工具里出现它的页面），需要的设置在项目里配。
 * 全局 MCP 库、全局 Skill 库里的条目同理：标成按项目的，才在 mcp / skills 里按名字记。
 *
 * 只记打开了的，没写的就是没打开。旧项目由迁移 0006 按「已经在项目里配置过」补上，升级后行为不变
 */
export const ProjectCapabilities = z.object({
  /** 打开了的按项目插件（插件 id） */
  plugins: z.array(z.string().min(1).max(40)).max(100).default([]),
  /** 打开了的按项目 MCP 工具（全局 MCP 库里的服务名） */
  mcp: z.array(z.string().min(1).max(120)).max(200).default([]),
  /** 打开了的按项目技能（全局 Skill 库里的名字） */
  skills: z.array(z.string().min(1).max(120)).max(500).default([]),
})
export type ProjectCapabilities = z.infer<typeof ProjectCapabilities>

/** 插件的生效方式：旧插件（接口 8 及以前）没写，一律当全局，照旧对所有项目生效 */
export type PluginActivation = 'global' | 'project'

/** 只用到的那几个字段，免得 shared 里互相 import 整个 Project */
type HasCaps = { capabilities?: Partial<ProjectCapabilities> }

/** 这个插件在这个项目（没有项目时传 undefined：Chat、无项目的对话）里生效不生效 */
export function pluginOnFor(project: HasCaps | undefined, id: string, activation: PluginActivation | undefined) {
  if ((activation ?? 'global') === 'global') return true
  return !!project?.capabilities?.plugins?.includes(id)
}

/** 打开 / 关掉项目里的一项能力，返回新的 capabilities（不改原对象） */
export function toggleCapability(
  caps: Partial<ProjectCapabilities> | undefined,
  kind: keyof ProjectCapabilities,
  name: string,
  on: boolean,
): ProjectCapabilities {
  const cur = ProjectCapabilities.parse(caps ?? {})
  const list = cur[kind].filter((x) => x !== name)
  return { ...cur, [kind]: on ? [...list, name] : list }
}
