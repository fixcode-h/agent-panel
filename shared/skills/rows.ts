/**
 * 设置「Agent 工具 → 技能」页的一行（ADR 0083）和改动的合并：服务端和演示后端用同一份，演示里不另写一套。
 * roles 是哪些角色自带它（角色点名了它就是角色自带，启动时带上），pushes 是最近推过几次（内存里的推送记录）
 */
import { z } from 'zod'
import type { EffectiveSkill } from './catalog.ts'
import { SkillWhen, type SkillOverride } from './schema.ts'

export const SkillRow = z.object({
  name: z.string(),
  source: z.enum(['builtin', 'plugin']),
  plugin: z.string().optional(),
  pluginName: z.string().optional(),
  guide: z.string(),
  when: z.array(SkillWhen),
  on: z.boolean(),
  always: z.boolean(),
  changed: z.boolean(),
  defaults: z.object({ when: z.array(SkillWhen), on: z.boolean() }),
  /** 自带这个技能的角色名 */
  roles: z.array(z.string()),
  /** 最近推过几次（所有对话；重启后从 0 算） */
  pushes: z.number(),
})
export type SkillRow = z.infer<typeof SkillRow>

export function skillRows(
  catalog: EffectiveSkill[],
  agents: { name: string; enabled: boolean; skills: string[] }[],
  counts: Map<string, number>,
): SkillRow[] {
  return catalog.map((s) => ({
    name: s.name,
    source: s.source,
    ...(s.plugin && { plugin: s.plugin }),
    ...(s.pluginName && { pluginName: s.pluginName }),
    guide: s.guide,
    when: s.when,
    on: s.on,
    always: s.always,
    changed: s.changed,
    defaults: s.defaults,
    roles: agents.filter((a) => a.enabled && a.skills.includes(s.name)).map((a) => a.name),
    pushes: counts.get(s.name) ?? 0,
  }))
}

/** 改一个技能：字段给 null 是恢复那一项的默认，reset 是全部恢复默认 */
export const SkillPatch = z.object({
  on: z.boolean().nullable().optional(),
  always: z.boolean().nullable().optional(),
  when: z.array(SkillWhen).max(20).nullable().optional(),
  reset: z.boolean().optional(),
})
export type SkillPatch = z.infer<typeof SkillPatch>

/**
 * 合并改动：和默认一样的不记（默认以后改了能跟着走）；全都是默认时返回 undefined（调用方删掉这一条）
 */
export function patchOverride(
  cur: SkillOverride | undefined,
  patch: SkillPatch,
  defaults: { when: SkillWhen[]; on: boolean },
): SkillOverride | undefined {
  if (patch.reset) return undefined
  const next: SkillOverride = { ...cur }
  const set = <K extends keyof SkillOverride>(k: K, v: SkillOverride[K] | null | undefined) => {
    if (v === undefined) return
    if (v === null) delete next[k]
    else next[k] = v
  }
  set('on', patch.on)
  set('always', patch.always)
  set('when', patch.when)
  if (next.on === defaults.on) delete next.on
  if (next.always === false) delete next.always
  if (next.when && JSON.stringify(next.when) === JSON.stringify(defaults.when)) delete next.when
  return Object.keys(next).length ? next : undefined
}
