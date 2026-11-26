/**
 * 设置「Agent 工具 → 技能」页的接口（ADR 0083，契约在 shared/api-contract/agent-tools.ts）：列出技能目录（自带 + 开着的插件带的，
 * 套上用户改动）、改一个技能的开关和条件、看某个技能最近的推送、改单个对话推送总量的上限。
 * 改动存在 config/hooks.json 的 skills（server/hooks/store.ts），上限是内置钩子 skill-push 的参数
 */
import { Hono } from 'hono'
import { agentToolsContract as C } from '../../shared/api-contract/agent-tools.ts'
import { BUILTIN_HOOKS } from '../../shared/hooks/builtins.ts'
import { t } from '../../shared/i18n.ts'
import { patchOverride, skillRows } from '../../shared/skills/rows.ts'
import { pluginEnabled, pluginById } from '../../shared/plugins/index.ts'
import type { Agent } from '../../shared/schema.ts'
import { allPluginEntries } from '../bundled-skills.ts'
import { readHooks, setBuiltinParam, setSkillOverride } from '../hooks/store.ts'
import { recentSkillPushes, skillPushCounts } from './push-ledger.ts'
import { catalogFor, skillPushBudget, skillPushOn } from './push.ts'
import type { PluginSkill } from './plugin-skills.ts'

/** 设置页看全部开着的插件带的技能（不分项目：按项目的插件也列出来，推的时候再看项目开没开） */
async function enabledPluginSkills(): Promise<PluginSkill[]> {
  const seen = new Set<string>()
  return (await allPluginEntries()).flatMap((e) => {
    if (!e.plugin || !pluginEnabled(e.plugin) || seen.has(e.name)) return []
    seen.add(e.name)
    return [{ entry: e, pluginName: pluginById(e.plugin)?.name ?? e.plugin }]
  })
}

export function agentToolsApi(deps: {
  agents: { list: () => Promise<Agent[]> }
  taskTitle: (id: string) => Promise<string>
}) {
  const app = new Hono()
  const rows = async () => {
    const data = await readHooks()
    const catalog = catalogFor(data, await enabledPluginSkills())
    return { data, catalog, rows: skillRows(catalog, await deps.agents.list(), skillPushCounts()) }
  }
  app.get(C.skills.path, async (c) => {
    const { data, rows: skills } = await rows()
    return c.json({ skills, limit: skillPushBudget(data), enabled: skillPushOn(data) })
  })
  app.put(C.updateSkill.path, async (c) => {
    const body = C.updateSkill.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('参数不对') }, 400)
    const name = c.req.param('name')
    const { data, catalog } = await rows()
    const s = catalog.find((x) => x.name === name)
    if (!s) return c.json({ error: t('没有这个技能：{name}', { name }) }, 404)
    await setSkillOverride(name, patchOverride(data.skills[name], body.data, s.defaults))
    const row = (await rows()).rows.find((x) => x.name === name)!
    return c.json(row)
  })
  app.get(C.skillPushes.path, async (c) => {
    const list = recentSkillPushes(c.req.param('name'), 10)
    const titles = new Map<string, string>()
    for (const p of list)
      if (!titles.has(p.taskId)) titles.set(p.taskId, await deps.taskTitle(p.taskId).catch(() => ''))
    return c.json({ pushes: list.map((p) => ({ ...p, title: titles.get(p.taskId) ?? '' })) })
  })
  app.put(C.setSkillLimit.path, async (c) => {
    const body = C.setSkillLimit.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('要是 {min} 到 {max} 之间的整数', { min: 0, max: 200000 }) }, 400)
    const def = BUILTIN_HOOKS.find((h) => h.id === 'skill-push')!.params!.find((p) => p.key === 'tokens')!.default
    await setBuiltinParam('skill-push', 'tokens', body.data.tokens, body.data.tokens === def)
    return c.json({ tokens: body.data.tokens })
  })
  return app
}
