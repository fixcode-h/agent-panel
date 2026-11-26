/**
 * 技能目录（./catalog.ts）生成情境规则：技能推送走情境规则那一套（shared/hooks/situational.ts 匹配，
 * server/hooks/situational.ts 按对话记、推），不另起一套匹配。一个技能按条件的时机最多两条规则：
 * 工具前（改 / 读文件、跑命令、调工具、收尾）一条，工具后（某类命令失败）一条；开跑时的条件不在这里（server/skills/launch-push.ts）。
 * 规则只说「对上了」，正文由服务端读，所以 text 不用
 */
import type { SituationCtx, SituationalRule } from '../hooks/situational.ts'
import type { ToolKind } from '../hooks/defs.ts'
import type { EffectiveSkill } from './catalog.ts'
import { whenMatchesCall, whenMoment, type SkillCallFacts, type SkillWhen } from './when.ts'

/** 钩子事实换成条件判断用的事实 */
export function callFacts(c: SituationCtx): SkillCallFacts | undefined {
  const t = c.facts.tool
  if (!t) return undefined
  return {
    kind: t.kind,
    tool: t.panel || t.name.split('__').at(-1) || '',
    paths: (t.paths.length ? t.paths : [t.path]).filter(Boolean),
    command: typeof t.input.command === 'string' ? t.input.command : '',
    failed: t.result?.failed,
    edited: c.edited,
  }
}

/** 这次工具调用对上了这个技能的哪一条条件（没对上为空） */
export function skillHitCall(s: Pick<EffectiveSkill, 'when'>, c: SituationCtx): SkillWhen | undefined {
  const f = callFacts(c)
  if (!f) return undefined
  return s.when.find((w) => whenMatchesCall(w, f, c.event))
}

/** 一条条件要钩子关心哪类工具：能按类别过滤的 CLI 只对这几类触发 */
const kindOf = (w: SkillWhen): ToolKind =>
  w.kind === 'edit'
    ? 'edit'
    : w.kind === 'read'
      ? 'read'
      : w.kind === 'command' || w.kind === 'failed'
        ? 'shell'
        : w.kind === 'phase'
          ? 'panel'
          : 'any'

/** 开着自动推的技能生成的规则 */
export function skillRules(skills: EffectiveSkill[]): SituationalRule[] {
  const out: SituationalRule[] = []
  for (const s of skills) {
    if (!s.on) continue
    for (const event of ['tool.before', 'tool.after'] as const) {
      const mine = s.when.filter((w) => whenMoment(w) === event)
      if (!mine.length) continue
      out.push({
        id: event === 'tool.before' ? `skill:${s.name}` : `skill:${s.name}:after`,
        name: () => s.name,
        skill: s.name,
        when: { event, kinds: [...new Set(mine.map(kindOf))], ...(event === 'tool.after' && { failed: true }) },
        need: (c) => !!skillHitCall({ when: mine }, c),
        text: () => '',
      })
    }
  }
  return out
}
