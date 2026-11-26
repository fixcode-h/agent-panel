/**
 * 技能推送（ADR 0083）：情境规则（server/hooks/situational.ts）和开跑（./launch-push.ts）对上某个技能后都走这里——
 * 读正文、按一个对话的推送总量上限决定推全文还是只给路径、记进推送记录（./push-ledger.ts）。
 *
 * - 同一个技能一个对话只推一次（推送记录里有就不推）；特化技能先带上它扩展的通用技能（base）；
 * - 上下文压缩后（context.restored）把推过的再推一次，原来只给了路径的照旧只给路径，补推不计入上限；
 * - 上限按估算的 token（shared/mcp-catalog/cost.ts）算，超了只推一行路径，用户能在「Agent 工具 → 技能」改上限。
 * 技能目录（自带 + 这个项目能用的插件技能 + 用户改动）也在这里合成
 */
import { BUILTIN_HOOKS, builtinNumber, builtinOn } from '../../shared/hooks/builtins.ts'
import type { HooksData } from '../../shared/hooks/defs.ts'
import { estimateTokens } from '../../shared/mcp-catalog/cost.ts'
import { pluginSkillGuide } from '../../shared/plugins/index.ts'
import { frontField } from '../../shared/library.ts'
import {
  builtinSkillSource,
  pluginSkillSource,
  skillCatalog,
  type EffectiveSkill,
} from '../../shared/skills/catalog.ts'
import { skillPathText, skillPushText } from '../../shared/skills/push-text.ts'
import type { PluginSkill } from './plugin-skills.ts'
import { pushedSkills, pushedTokens, recordSkillPush, skillPushes } from './push-ledger.ts'
import { skillBody } from './skill-body.ts'

const SKILL_PUSH = BUILTIN_HOOKS.find((h) => h.id === 'skill-push')!

/** 技能推送开没开（内置钩子 skill-push，可按项目关）：不看扶持档位，精简档也开 */
export const skillPushOn = (data: HooksData, projectId = '') => builtinOn(data, SKILL_PUSH, projectId)

/** 一个对话最多推多少 token 的正文 */
export const skillPushBudget = (data: HooksData) => builtinNumber(data, 'skill-push', 'tokens')

/** 技能目录：自带的 + 给出的插件技能，套上用户改动 */
export function catalogFor(data: Pick<HooksData, 'skills'>, plugins: PluginSkill[]): EffectiveSkill[] {
  const list = plugins.map((p) => ({
    name: p.entry.name,
    plugin: p.entry.plugin ?? '',
    pluginName: p.pluginName,
    guide:
      pluginSkillGuide(p.entry.name) ??
      frontField(p.entry.files.get('SKILL.md')?.toString('utf8') ?? '', 'description')
        .replace(/\s+/g, ' ')
        .slice(0, 160),
  }))
  return skillCatalog([builtinSkillSource, pluginSkillSource(list)], data.skills)
}

export interface PushCtx {
  taskId: string
  budget: number
  catalog: EffectiveSkill[]
  /** 推了一个技能（会话栏「技能」那一行记下来） */
  onPushed?: (name: string) => void
}

/**
 * 推一个技能（和它的 base）：返回交给模型的文字，推过的、不认识的返回空串。
 * why 是给模型看的「为什么推」，trigger 是记进推送记录的条件
 */
export async function pushSkill(c: PushCtx, name: string, why: string, trigger: string): Promise<string> {
  if (pushedSkills(c.taskId).has(name)) return ''
  const s = c.catalog.find((x) => x.name === name)
  const out: string[] = []
  if (s?.base) {
    const base = await pushSkill(c, s.base, why, `base:${name}`)
    if (base) out.push(base)
  }
  const b = await skillBody(name)
  if (!b) return out.join('\n\n')
  const full = skillPushText({ ...b, why })
  const tokens = estimateTokens(full)
  const over = pushedTokens(c.taskId) + tokens > c.budget
  const text = over ? skillPathText({ name, why, dir: b.dir }) : full
  recordSkillPush(c.taskId, {
    skill: name,
    chars: text.length,
    tokens: over ? estimateTokens(text) : tokens,
    at: new Date().toISOString(),
    trigger: over ? `path:${trigger}` : trigger,
  })
  c.onPushed?.(name)
  out.push(text)
  return out.join('\n\n')
}

/** 上下文压缩后：推过的技能再推一次（只给过路径的照旧只给路径），每个技能只补一份 */
export async function repushSkills(taskId: string): Promise<string> {
  const firsts = new Map<string, string>()
  for (const p of skillPushes(taskId))
    if (p.trigger !== 'restored' && !firsts.has(p.skill)) firsts.set(p.skill, p.trigger)
  const out: string[] = []
  for (const [name, trigger] of firsts) {
    const b = await skillBody(name)
    if (!b) continue
    const why = '之前推过'
    const text = trigger.startsWith('path')
      ? skillPathText({ name, why, dir: b.dir })
      : skillPushText({ ...b, why }, true)
    recordSkillPush(taskId, {
      skill: name,
      chars: text.length,
      tokens: estimateTokens(text),
      at: new Date().toISOString(),
      trigger: 'restored',
    })
    out.push(text)
  }
  return out.join('\n\n')
}
