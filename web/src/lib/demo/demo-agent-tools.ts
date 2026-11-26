/**
 * 演示：设置「Agent 工具 → 技能」（ADR 0083）。技能目录、改动的合并、每行的样子都用 shared 里和服务端同一份
 * （skillCatalog、patchOverride、skillRows）；演示里没有真的对话在跑，最近推送是几条写好的样例
 */
import type { Agent } from '@shared/schema'
import { builtinParam, BUILTIN_HOOKS } from '@shared/hooks/builtins'
import { builtinSkillSource, pluginSkillSource, skillCatalog, type SkillOverride } from '@shared/skills/catalog'
import { patchOverride, skillRows, SkillPatch } from '@shared/skills/rows'
import { demoBuiltinOn, demoHookParams } from './demo-hooks'
import { fail } from './demo-http'

// 模块状态：演示里改的技能开关和条件只在这一页里，刷新回到默认
const overrides: Record<string, SkillOverride> = {}

/** 演示里装着的 UE 插件带的技能 */
const PLUGIN = pluginSkillSource([
  {
    name: 'ue-asset-forge',
    plugin: 'ue',
    pluginName: 'Unreal Engine',
    guide: '用 JSON 配置批量导入、导出、同步 UE 资产时',
  },
])

const AT = (min: number) => new Date(Date.UTC(2026, 10, 26, 8, 40 - min)).toISOString()
const SAMPLE: Record<string, { taskId: string; title: string; at: string; trigger: string; tokens: number }[]> = {
  'lua-code-style': [
    { taskId: 'demo-task-1', title: '背包出售按钮没反应', at: AT(3), trigger: 'edit **/*.lua', tokens: 2380 },
    { taskId: 'demo-task-2', title: '商店界面日志整理', at: AT(26), trigger: 'params lang=lua', tokens: 2380 },
    { taskId: 'demo-task-2', title: '商店界面日志整理', at: AT(12), trigger: 'restored', tokens: 2390 },
  ],
  'verification-before-completion': [
    { taskId: 'demo-task-1', title: '背包出售按钮没反应', at: AT(1), trigger: 'phase finishing', tokens: 1010 },
  ],
  'project-vcs': [{ taskId: 'demo-task-3', title: '提交前整理改动', at: AT(40), trigger: 'command vcs', tokens: 1690 }],
}

const catalog = () => skillCatalog([builtinSkillSource, PLUGIN], overrides)
const limit = () => {
  const h = BUILTIN_HOOKS.find((x) => x.id === 'skill-push')!
  return builtinParam({ params: demoHookParams() }, h, 'tokens') as number
}
const rows = (agents: Agent[]) =>
  skillRows(catalog(), agents, new Map(Object.entries(SAMPLE).map(([k, v]) => [k, v.length])))

export function demoAgentTools(method: string, seg: string[], body: unknown, agents: Agent[]) {
  const [, kind, name, sub] = seg
  if (kind === 'skills' && method === 'GET' && !name)
    return { skills: rows(agents), limit: limit(), enabled: demoBuiltinOn('skill-push') }
  if (kind === 'skills' && name && sub === 'pushes')
    return {
      pushes: (SAMPLE[name] ?? []).map((p) => ({ ...p, chars: Math.round(p.tokens * 1.6) })),
    }
  if (kind === 'skills' && name && method === 'PUT') {
    const s = catalog().find((x) => x.name === name) ?? fail(`没有这个技能：${name}`, 404)
    const next = patchOverride(overrides[name], SkillPatch.parse(body), s.defaults)
    if (next) overrides[name] = next
    else delete overrides[name]
    return rows(agents).find((x) => x.name === name)
  }
  if (kind === 'skill-limit' && method === 'PUT') {
    const tokens = Number((body as { tokens?: number }).tokens)
    if (!Number.isInteger(tokens) || tokens < 0 || tokens > 200000) fail('要是 0 到 200000 之间的整数')
    const p = demoHookParams()
    p['skill-push'] = { ...p['skill-push'], tokens }
    return { tokens }
  }
  return fail('演示不支持这个操作', 404)
}
