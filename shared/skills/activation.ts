import { z } from 'zod'
import type { PluginActivation } from '../projects/capabilities.ts'

/**
 * 全局技能的生效方式（设计稿：Agent侧栏与项目管理重设计 6.2「技能」，工作包 W4）。
 *
 * - global（默认）：照旧放在用户目录（自带技能在 ~/.agents/skills，自己的技能在各 CLI 的用户目录），所有项目都读得到；
 * - project：不再放在用户目录。自带技能从 ~/.agents/skills 撤掉，自己的技能挪进面板数据目录；每轮只给
 *   在项目能力里打开了它（project.capabilities.skills）的项目带上，按 CLI 定义的 runSkills 交给 CLI。
 *
 * 按技能名记，不分 CLI：同名的自带技能和各 CLI 目录里的同名技能一起切。只记按项目的，没写的就是全局
 */
export const SkillActivationConfig = z.object({
  project: z.array(z.string().min(1).max(120)).max(500).default([]),
})
export type SkillActivationConfig = z.infer<typeof SkillActivationConfig>

export const SkillActivationInput = z.object({
  name: z.string().trim().min(1).max(120),
  activation: z.enum(['global', 'project']),
})
export type SkillActivationInput = z.infer<typeof SkillActivationInput>

/** 切换的结果：界面上照着说做了什么、哪些因为用户改过没动 */
export interface SkillActivationResult {
  name: string
  activation: PluginActivation
  /** 挪动了自己的技能的 CLI（按项目时挪进面板数据目录，改回全局时挪回 CLI 的用户目录） */
  moved: string[]
  /** 从用户目录撤掉的自带技能副本（和自带的一模一样的才撤） */
  removed: string[]
  /** 留在原处没动的路径：自带技能被改过，或者要挪回去的地方已经有同名技能 */
  kept: string[]
}

/**
 * 这一轮要带上的按项目技能：项目能力里打开了的，加上角色点名要用的（角色明确要的不受项目开关限制，
 * 不然换个项目角色就缺技能）；只算标成按项目的，全局的本来就在用户目录里
 */
export function runSkillNames(projectMode: Iterable<string>, opened: string[] | undefined, roleSkills: string[]) {
  const mode = new Set(projectMode)
  return [...new Set([...(opened ?? []), ...roleSkills])].filter((n) => mode.has(n)).sort()
}

/** 不能按会话加载技能的 CLI：在提示里列出技能和路径，让它需要时自己读（同「部署」的全局说明末尾那份清单） */
export function runSkillsNote(dir: string, skills: { name: string; description: string }[]) {
  if (!skills.length) return ''
  const rows = skills.map((s) => `- ${s.name}：${s.description || '（没有说明）'}（\`${dir}/${s.name}/SKILL.md\`）`)
  return `## 这个项目打开的技能\n任务用得上时先读对应的 SKILL.md，不用的不必读。\n${rows.join('\n')}`
}

/** 角色点名的技能里按项目的那些放在这一轮的技能目录里，不在 ~/.agents/skills：在角色的技能说明后补一句 */
export function roleSkillDirNote(dir: string, names: string[]) {
  if (!names.length) return ''
  return `其中 ${names.join('、')} 这一轮放在 \`${dir}\`，路径是 \`${dir}/<名字>/SKILL.md\`。`
}

/** 说明太长时只取前面一段：提示里每个技能一行，够模型判断什么时候用就行，细节在 SKILL.md 里 */
const clipDesc = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 160 ? `${one.slice(0, 160)}…` : one
}

/**
 * 开着的插件带的技能（server/skills/plugin-skills.ts）：列名字、哪个插件、什么时候用、SKILL.md 在哪。
 * 不写清楚时模型只知道「装了个插件」，会自己 find 插件目录、which 命令行工具找半天（2026-11-18 用户截图）
 */
export function pluginSkillsNote(skills: { name: string; plugin: string; description: string; file: string }[]) {
  if (!skills.length) return ''
  const rows = skills.map(
    (s) => `- \`${s.name}\`（插件「${s.plugin}」）：${clipDesc(s.description) || '（没有说明）'}。说明在 \`${s.file}\``,
  )
  return [
    '## 装着的插件带的技能',
    '这些技能已经交给你了：任务对得上、或者用户提到这个插件时，直接读对应的 SKILL.md 照做，不要再去搜索插件目录、技能目录或找命令行工具。用户在输入框里打「/名字 要求」就是点名要用这个技能。',
    ...rows,
  ].join('\n')
}
