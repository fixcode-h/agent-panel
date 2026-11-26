/**
 * 这个项目这一轮能用的插件技能（插件开着、按项目的插件在这个项目里打开了）。
 *
 * 以前这些技能每轮全部放进技能目录、提示里再列一节「装着的插件带的技能」；现在启动时不带（ADR 0083），
 * 由技能目录（shared/skills/catalog.ts 的 pluginSkillSource）按条件在用得上时推正文，用户「/名字」点名照样能用。
 * 这里只回答「这个项目能推哪些插件技能」；标成按项目的技能照旧只看项目能力里的开关
 */
import { pluginById, pluginEnabled } from '../../shared/plugins/index.ts'
import { pluginOnFor } from '../../shared/projects/capabilities.ts'
import { allPluginEntries, type Entry } from '../bundled-skills.ts'
import { isProjectSkill } from './config.ts'

export interface PluginSkill {
  entry: Entry
  /** 插件的显示名（设置页和「/」菜单里写明是哪个插件带的） */
  pluginName: string
}

/** 这个项目这一轮能用的插件技能：插件开着、按项目的插件在这个项目里打开了，技能本身没标成按项目 */
export async function pluginSkillsFor(project: Parameters<typeof pluginOnFor>[0]): Promise<PluginSkill[]> {
  const out: PluginSkill[] = []
  const seen = new Set<string>()
  for (const e of await allPluginEntries()) {
    const id = e.plugin
    if (!id || !pluginEnabled(id) || seen.has(e.name) || isProjectSkill(e.name)) continue
    const m = pluginById(id)
    if (!pluginOnFor(project, id, m?.activation)) continue
    seen.add(e.name)
    out.push({ entry: e, pluginName: m?.name ?? id })
  }
  return out
}
