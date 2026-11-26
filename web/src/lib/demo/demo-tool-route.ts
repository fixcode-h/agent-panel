/**
 * 演示版：对话里两行面板 find，带上「实际走的路」（ToolUse.route）——一行 Lua 查符号走 IDEA 的 lua_code（MCP），
 * 一行按文本找时 VS 的服务没开、跳过后面板按文本找。工具卡片耗时旁的小标和点开后的路由步骤都要有东西看
 */
import type { Task } from '@shared/schema'
import { noteSkillUsage } from '@shared/skills/usage'

export function demoFindRows(task: Task, agentId: string) {
  task.messages.push({
    id: 'demo-find-route',
    role: 'agent',
    agentId,
    step: '',
    text: '',
    tools: [
      {
        kind: 'other',
        name: 'MCP',
        label: 'panel · find',
        detail: '',
        input: JSON.stringify({ action: 'symbol', query: 'OnSellAll', lang: 'lua' }, null, 2),
        output: 'Content/Script/UI/BagPanel.lua:212: function BagPanel:OnSellAll()',
        ms: 126,
        route: {
          capability: 'find',
          served: [{ source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp' }],
          steps: [{ source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp', outcome: 'used', ms: 120 }],
          ms: 126,
        },
      },
      {
        kind: 'other',
        name: 'MCP',
        label: 'panel · find',
        detail: '',
        input: JSON.stringify({ action: 'text', query: 'CartBadge' }, null, 2),
        output: 'src/components/CartBadge.tsx:3: export function CartBadge() {\nsrc/App.tsx:18:   <CartBadge />',
        ms: 406,
        route: {
          capability: 'find',
          served: [{ source: 'panel.text', label: '面板按文本找', via: 'panel' }],
          steps: [
            {
              source: 'ue:uetovs.search_symbols',
              label: 'search_symbols',
              via: 'mcp',
              outcome: 'skipped',
              why: '没有接 search_symbols 所在的服务（没装，或服务没开）',
            },
            { source: 'panel.text', label: '面板按文本找', via: 'panel', outcome: 'used', ms: 380 },
          ],
          ms: 406,
        },
      },
      // 经面板代理的外部工具（ADR 0085）：调的是 more_tools，卡片按 idea · lua_debug_inspect 显示，小标写 via MCP
      {
        kind: 'other',
        name: 'MCP',
        label: 'panel · more_tools',
        detail: '',
        input: JSON.stringify({ name: 'idea/lua_debug_inspect', arguments: { action: 'stack' } }, null, 2),
        output:
          '{"count":2,"items":[{"frame":0,"fn":"BagPanel:OnSellAll","line":212},{"frame":1,"fn":"Button:OnClick","line":40}]}',
        ms: 85,
        route: {
          capability: 'mcp',
          served: [{ source: 'proxy:idea', label: 'idea · lua_debug_inspect', via: 'mcp' }],
          steps: [{ source: 'proxy:idea', label: 'idea · lua_debug_inspect', via: 'mcp', outcome: 'used', ms: 80 }],
          ms: 85,
        },
      },
    ],
    at: new Date().toISOString(),
  })
}

/** 会话栏「环境 → 技能」（ADR 0083）：开跑带上的两个、面板按情境推过正文的一个，演示里也要能点开看 */
export function demoSkillUsage(task: Task, agentId: string) {
  noteSkillUsage(task.usage.agents[agentId], {
    carried: ['frontend-design', 'project-vcs'],
    pushed: ['systematic-debugging'],
  })
}
