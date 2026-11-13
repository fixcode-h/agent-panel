import { describeTool } from '@shared/mcp-catalog/describe'
import {
  APP_ATTACH,
  APP_SUMMARY,
  PANEL_ATTACH,
  PANEL_SUMMARY,
  PANEL_TOOL_GUIDE,
  OLD_GROUP,
} from '@shared/mcp-catalog/panel-guides'
import type { Audience, CatalogTool, McpCatalog, McpCheckResult } from '@shared/mcp-catalog/types'
import { t } from '@shared/i18n'

/**
 * 演示后端的设置 →「MCP」（web/src/lib/demo-backend.ts 转过来）：演示里没有服务端的工具注册表，
 * 面板工具按 shared 里同一份声明列出（说明用同一个 describeTool 拼），给谁不标；演示不装插件，只有面板自带的两个来源
 */

function panelTools(): CatalogTool[] {
  return Object.entries(PANEL_TOOL_GUIDE)
    .filter(([, g]) => g.group !== OLD_GROUP)
    .map(([name, { effects, ...g }]) => ({
      name,
      title: g.title,
      guide: g,
      effects,
      description: describeTool(g.summary, g),
      params: [],
    }))
}

const ACTIONS = [
  ['task.stop_children', '停止子对话', '停掉这个对话名下正在跑的子对话。', 'danger'],
  ['task.create', '新建对话', '在项目里新建一个对话并发出第一条消息。', 'write'],
  ['settings.get', '读设置', '读面板的设置。', 'read'],
  ['ui.open_page', '打开页面', '在用户开着的面板里打开某一页。', 'write'],
] as const

export function demoMcpCatalog(method: string, id?: string, body?: unknown): McpCatalog | McpCheckResult {
  if (method === 'POST' && id === 'check') {
    const kind = ((body ?? {}) as { kind?: Audience }).kind ?? 'parent'
    const n = panelTools().length
    const app = kind === 'parent' || kind === 'child' || kind === 'chat'
    return {
      cli: { id: 'claude', name: 'Claude Code', mcp: true },
      rows: [
        {
          source: 'panel',
          name: t('Agent 面板'),
          server: 'agent-panel',
          state: 'on',
          count: n,
          reason: t('最多 {n} 个，具体随角色能力和项目设置', { n }),
        },
        {
          source: 'app',
          name: t('操控软件'),
          server: 'app_do',
          state: app ? 'on' : 'off',
          count: app ? ACTIONS.length : 0,
          reason: app
            ? t('{n} 个面板动作，经 app_actions / app_do 调', { n: ACTIONS.length })
            : t('派出的子任务和工作流节点没有操控软件的动作'),
        },
      ],
      missing: [],
    }
  }
  return {
    sources: [
      {
        id: 'panel',
        kind: 'panel',
        name: t('Agent 面板'),
        summary: PANEL_SUMMARY,
        servers: [{ name: 'agent-panel', summary: PANEL_SUMMARY, attach: PANEL_ATTACH, tools: panelTools() }],
        actions: [],
      },
      {
        id: 'app',
        kind: 'app',
        name: t('操控软件'),
        summary: `${APP_SUMMARY} ${APP_ATTACH}`,
        servers: [],
        actions: ACTIONS.map(([name, title, description, level]) => ({
          name,
          title,
          description,
          level,
          group: name.split('.')[0]!,
        })),
      },
    ],
    mine: 0,
  }
}
