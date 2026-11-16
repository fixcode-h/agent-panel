import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginRow } from '@/plugins/registry'
import { itemOn, pluginMcpItems } from './caps-items'

const row = (id: string, activation: 'global' | 'project', enabled = true) =>
  ({ enabled, manifest: { id, name: id, description: '', mcpServers: [id], activation } }) as unknown as PluginRow

// 起因：UE 插件在项目「能力」里打开了，「技能与 MCP」页却标「没打开」——插件 MCP 拿显示名去 capabilities.mcp 里找
test('按项目的插件 MCP 在打开了它的项目里算打开', () => {
  const project = { capabilities: { plugins: ['ue'], mcp: [], skills: [] } }
  const items = pluginMcpItems([row('ue', 'project'), row('video', 'global')], project)
  assert.deepEqual(
    items.map((x) => [x.key, x.scope, itemOn(x, project.capabilities)]),
    [
      ['mcp:plugin:ue', 'project', true],
      ['mcp:plugin:video', 'global', true],
    ],
  )
})

test('没打开的项目、全局关着的插件不列', () => {
  const project = { capabilities: { plugins: [], mcp: [], skills: [] } }
  assert.deepEqual(
    pluginMcpItems([row('ue', 'project'), row('blender', 'global', false)], project).map((x) => x.key),
    [],
  )
})
