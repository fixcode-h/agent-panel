import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCard } from './sdk.ts'
import { pickToolCard } from './tool-cards.tsx'

const card = (id: string, tool: string, match?: ToolCard['match']): ToolCard => ({ id, tool, match, Card: () => null })
const call = (label: string, args: object) => ({ name: 'MCP', label, input: JSON.stringify(args) })

test('工具卡片：按工具名认（不看服务名），match 筛参数，先登记的插件优先；不是 MCP 调用不认', () => {
  const plugins: [string, { toolCards?: ToolCard[] }][] = [
    ['ue', { toolCards: [card('gt-run', 'ue_gametest', (a) => a.action === 'run')] }],
    ['other', { toolCards: [card('any', 'ue_gametest')] }],
  ]
  assert.equal(pickToolCard(plugins, call('agentpanel · ue_gametest', { action: 'run' }))?.id, 'gt-run')
  assert.equal(pickToolCard(plugins, call('ue · ue_gametest', { action: 'look' }))?.id, 'any')
  assert.equal(pickToolCard(plugins, call('ue · ue_status', {})), undefined)
  assert.equal(pickToolCard(plugins, { name: 'Bash', label: 'ls', input: '{}' }), undefined)
})
