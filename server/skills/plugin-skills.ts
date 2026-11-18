/**
 * 装着的插件带的技能每轮直接交给 Agent（插件装上就能用）。
 *
 * 以前插件技能只在「自带 Skill」页点了安装、或者角色点名要用时才装进 ~/.agents/skills；
 * 只带技能的包装插件（Archify 这类）没有角色，装好后 Agent 根本看不到，只能自己 find 插件目录
 * （2026-11-18 用户截图：协调器先跑了一串 find / ls / which 才找到 archify 的 SKILL.md）。
 *
 * 现在：开着的插件（按项目生效的只算这个项目打开了的）带的技能，每轮和按项目的技能一起放进这一轮的技能目录
 * （server/skills/run-skills.ts），关掉插件下一轮就没了，升级后下一轮就是新版；提示里再列一份名字、用法和路径，
 * 并告诉 Agent 用户可以打「/名字」点名用它。
 * 标成按项目的技能照旧只看项目能力里的开关；用户已经装进 ~/.agents/skills 的那份照旧由 CLI 自己读，不再放一份重复的。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pluginById, pluginEnabled } from '../../shared/plugins/index.ts'
import { pluginOnFor } from '../../shared/projects/capabilities.ts'
import { allPluginEntries, sharedRoot, type Entry } from '../bundled-skills.ts'
import { isProjectSkill } from './config.ts'

export interface PluginSkill {
  entry: Entry
  /** 插件的显示名（提示和「/」菜单里写明是哪个插件带的） */
  pluginName: string
  /** 已经装进 ~/.agents/skills（自带 Skill 页装的、角色补的）：读 ~/.agents/skills 的 CLI 不再另放一份 */
  shared: boolean
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
    out.push({
      entry: e,
      pluginName: m?.name ?? id,
      shared: existsSync(path.join(sharedRoot(), e.name, 'SKILL.md')),
    })
  }
  return out
}
