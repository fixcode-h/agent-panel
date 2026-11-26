import { z } from 'zod'
import type { PluginActivation } from '../projects/capabilities.ts'

/**
 * 全局技能的生效方式（设计稿：Agent侧栏与项目管理重设计 6.2「技能」，工作包 W4）。
 *
 * - global（默认）：自己的技能照旧在各 CLI 的用户目录，所有项目都读得到；自带技能装在面板数据目录，
 *   角色点名了才带、其余按情境推（ADR 0083）；
 * - project：自带技能从面板数据目录撤掉，自己的技能挪进面板数据目录；每轮只给
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
 * 这一轮带进技能目录的（ADR 0083）：角色点名要用的（含每个对话都带的），加上项目能力里打开了的按项目技能
 * （角色明确要的不受项目开关限制，不然换个项目角色就缺技能）。其余的启动时不带，由面板按情境推
 */
export function runSkillNames(projectMode: Iterable<string>, opened: string[] | undefined, roleSkills: string[]) {
  const mode = new Set(projectMode)
  return [...new Set([...(opened ?? []).filter((n) => mode.has(n)), ...roleSkills])].sort()
}

/** 不能按会话加载技能的 CLI：在提示里列出这一轮带的技能和路径，让它需要时自己读（只列角色自带的，不是全部技能） */
export function runSkillsNote(dir: string, skills: { name: string; description: string }[]) {
  if (!skills.length) return ''
  const rows = skills.map((s) => `- ${s.name}：${s.description || '（没有说明）'}（\`${dir}/${s.name}/SKILL.md\`）`)
  return `## 这一轮带的技能\n任务用得上时先读对应的 SKILL.md，不用的不必读。\n${rows.join('\n')}`
}

/** 用户设成「每个对话都带」的技能：角色设定里没列，补一句它们在哪、要照着做 */
export function alwaysSkillsNote(dir: string, names: string[]) {
  if (!names.length) return ''
  return `用户要求每个对话都按这些技能做：${names.map((n) => `\`${n}\``).join('、')}，SKILL.md 在 \`${dir}/<名字>/SKILL.md\`，开始做之前先读。`
}
