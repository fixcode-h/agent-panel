/**
 * 面板自带的两个来源（设置 →「MCP」）：agent-panel 服务的工具、操控软件的动作表。
 * 工具定义、给不给的条件都取注册表里同一份（server/panel-tools/registry.ts），说明按声明拼好（./guides.ts），
 * 所以这里列出的就是 Agent 拿到的原文。
 */
import { describeTool, paramsOf } from '../../shared/mcp-catalog/describe.ts'
import {
  APP_ATTACH,
  APP_SUMMARY,
  PANEL_ATTACH,
  PANEL_SUMMARY,
  PANEL_TOOL_GUIDE,
} from '../../shared/mcp-catalog/panel-guides.ts'
import {
  AUDIENCES,
  type Audience,
  type CatalogAction,
  type CatalogSource,
  type CatalogTool,
  type McpCheckRow,
} from '../../shared/mcp-catalog/types.ts'
import { DEFERRED_TOOLS, splitDeferred, type PanelToolName } from '../../shared/panel-tools.ts'
import { t } from '../../shared/i18n.ts'
import { NOTES_TOOL, TOOL as ASK_TOOL, WAIT_TOOL } from '../ask-mcp.ts'
import { APP_TOOLS } from '../app-actions/mcp.ts'
import { appActions } from '../app-actions/index.ts'
import { groupOf, type AppAction } from '../app-actions/registry.ts'
import { PANEL_TOOLS } from '../panel-tools/registry.ts'
import { AUDIENCE_REPS, EXTRA_AUDIENCE } from './audiences.ts'

type Def = { name: string; title?: string; description: string; inputSchema: unknown }

/** 不在注册表里、挂在同一个服务上的几个（提问、补充、等下一句、操控软件） */
const EXTRA: Def[] = [ASK_TOOL, NOTES_TOOL, WAIT_TOOL, ...APP_TOOLS]

function toolRow(d: Def, audience: Audience[]): CatalogTool {
  const guide = PANEL_TOOL_GUIDE[d.name as PanelToolName]
  const { effects, ...g } = guide
  return {
    name: d.name,
    title: g.title,
    guide: g,
    effects,
    description: describeTool(d.description, g),
    params: paramsOf(d.inputSchema),
    audience,
    ...(DEFERRED_TOOLS.includes(d.name) && { deferred: true }),
  }
}

/** 每类对话的代表拿到哪些面板工具（注册表 + 挂在同一服务上的几个） */
function toolsFor(kind: Audience): Def[] {
  const o = AUDIENCE_REPS[kind]
  const reg = PANEL_TOOLS.filter((x) => x.def && x.when(o)).map((x) => x.def!(o))
  return [...EXTRA.filter((x) => EXTRA_AUDIENCE[x.name]?.includes(kind)), ...reg]
}

/** agent-panel 服务：每个工具一行，同名的几份（request_build 父对话、子对话两份）合成一行 */
export function panelSource(): CatalogSource {
  const rows = new Map<string, { def: Def; audience: Audience[] }>()
  for (const kind of AUDIENCES)
    for (const d of toolsFor(kind)) {
      const r = rows.get(d.name) ?? { def: d, audience: [] }
      if (!r.audience.includes(kind)) r.audience.push(kind)
      rows.set(d.name, r)
    }
  return {
    id: 'panel',
    kind: 'panel',
    name: t('Agent 面板'),
    summary: PANEL_SUMMARY,
    servers: [
      {
        name: 'agent-panel',
        summary: PANEL_SUMMARY,
        attach: PANEL_ATTACH,
        tools: [...rows.values()].map((r) => toolRow(r.def, r.audience)),
      },
    ],
    actions: [],
  }
}

export const actionRow = (a: AppAction): CatalogAction => ({
  name: a.name,
  title: a.title,
  description: a.description,
  level: a.level,
  group: groupOf(a.name),
  ...(a.useWhen && { useWhen: a.useWhen }),
  ...(a.avoidWhen && { avoidWhen: a.avoidWhen }),
})

/** 操控软件：面板自己的动作（插件登记的归到各插件那一页） */
export function appSource(pluginActionNames: Set<string>): CatalogSource {
  return {
    id: 'app',
    kind: 'app',
    name: t('操控软件'),
    summary: `${APP_SUMMARY} ${APP_ATTACH}`,
    servers: [],
    actions: appActions
      .list()
      .filter((a) => !pluginActionNames.has(a.name))
      .map(actionRow),
  }
}

/** 自检里面板服务那一行：这类对话最多拿到几个、几个收进 more_tools */
export function panelCheckRow(kind: Audience): McpCheckRow {
  const { listed, deferred } = splitDeferred(toolsFor(kind))
  const count = listed.length - (deferred.length ? 1 : 0) + deferred.length
  return {
    source: 'panel',
    name: t('Agent 面板'),
    server: 'agent-panel',
    state: 'on',
    count,
    deferred: deferred.length,
    reason: deferred.length
      ? t('最多 {n} 个：直接列出 {a} 个，{b} 个收进 more_tools；具体随角色能力和项目设置', {
          n: count,
          a: count - deferred.length,
          b: deferred.length,
        })
      : t('最多 {n} 个，具体随角色能力和项目设置', { n: count }),
  }
}

/** 操控软件那一行：只有用户在聊的对话有 */
export function appCheckRow(kind: Audience, pluginActionNames: Set<string>): McpCheckRow {
  const on = EXTRA_AUDIENCE.app_do!.includes(kind)
  const n = appActions.list().filter((a) => !pluginActionNames.has(a.name)).length
  return {
    source: 'app',
    name: t('操控软件'),
    server: 'app_do',
    state: on ? 'on' : 'off',
    count: on ? n : 0,
    reason: on
      ? t('{n} 个面板动作，经 app_actions / app_do 调', { n })
      : t('派出的子任务和工作流节点没有操控软件的动作'),
  }
}
