/**
 * 设置 →「MCP」的接口（设计稿：designs/MCP能力菜单-设计稿.md）：
 * - GET /mcp-catalog：面板自带的服务和动作、开着的插件各自给 Agent 的能力，说明是交给 Agent 的原文；
 * - POST /mcp-catalog/check：选项目、角色、CLI、对话类型，按真实规则现算 Agent 这一轮能拿到什么。
 */
import { Hono } from 'hono'
import { getCli } from '../../shared/clis.ts'
import { mcpCatalogContract as C } from '../../shared/api-contract/mcp-catalog.ts'
import type { Agent } from '../../shared/schema.ts'
import { includedAgents } from '../../shared/agents/role.ts'
import { t } from '../../shared/i18n.ts'
import type { McpCatalog, McpCheckInput, McpCheckResult } from '../../shared/mcp-catalog/types.ts'
import { mcpOverview } from '../mcp-store.ts'
import { appCheckRow, appSource, panelCheckRow, panelSource } from './panel.ts'
import { missingGuides, pluginCheckRows, pluginSources } from './plugins.ts'
import { lastMount } from './last-run.ts'

export interface McpCatalogDeps {
  agents: { list: () => Promise<Agent[]> }
  projects: { get: (id: string) => Promise<{ path: string } | null> }
  taskTitle: (id: string) => Promise<string>
}

export async function buildCatalog(): Promise<McpCatalog> {
  const { sources, actionNames } = await pluginSources()
  const mine = await mcpOverview()
    .then((o) => o.servers.length)
    .catch(() => 0)
  return { sources: [panelSource(), appSource(actionNames), ...sources], mine }
}

export async function runCheck(input: McpCheckInput, deps: McpCatalogDeps): Promise<McpCheckResult> {
  const def = getCli(input.cli)
  const cli = { id: input.cli, name: def?.name ?? input.cli, mcp: !!def?.mcp }
  const last = lastMount()
  const lastOut = last && {
    at: last.at,
    title: await deps.taskTitle(last.taskId),
    tools: last.tools,
    errors: last.errors,
  }
  // 不支持 MCP 的 CLI 一个工具都拿不到：不用往下算
  if (!cli.mcp) return { cli, rows: [], missing: [], ...(lastOut && { last: lastOut }) }
  const agents = await deps.agents.list()
  const agent = agents.find((a) => a.id === input.agentId)
  const project = input.projectId ? await deps.projects.get(input.projectId) : null
  const kind = input.kind
  const { sources, actionNames } = await pluginSources()
  const plugins = await pluginCheckRows({
    taskId: '',
    ...(kind === 'child' && { parentTaskId: 'dry-run' }),
    projectId: input.projectId,
    cwd: project?.path ?? '',
    mode: kind === 'chat' ? 'chat' : 'workflow',
    conversation: kind === 'parent' || kind === 'child' || kind === 'chat',
    agentName: agent?.name ?? '',
    skills: agent
      ? [...new Set([...agent.skills, ...includedAgents(agent, agents).flatMap((x) => x.agent.skills)])]
      : [],
    resume: false,
    dryRun: true,
  })
  const rows = [panelCheckRow(kind), appCheckRow(kind, actionNames), ...plugins]
  const on = new Set(rows.filter((r) => r.state === 'on').map((r) => r.source))
  return { cli, rows, missing: missingGuides(sources, on), ...(lastOut && { last: lastOut }) }
}

export function mcpCatalogApi(deps: McpCatalogDeps) {
  return new Hono()
    .get('/', async (c) => c.json(await buildCatalog()))
    .post('/check', async (c) => {
      const body = C.check.body.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: t('自检的参数不对') }, 400)
      return c.json(await runCheck(body.data, deps))
    })
}
