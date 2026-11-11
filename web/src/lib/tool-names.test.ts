import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolView } from './tasks.ts'
import { PANEL_TOOL_NAMES } from '../../../shared/panel-tools.ts'
import { panelToolTitle, serverTitle, toolTitle } from '../../../shared/tool-names.ts'
import { setLang } from '../../../shared/i18n.ts'
import { setInstalledPlugins } from '../../../shared/plugins/index.ts'
import { PluginManifest } from '../../../shared/plugins/types.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

const tool = (name: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'other', name, label, detail: '', input: '', ...extra }) as Parameters<typeof toolView>[0]

test('面板工具总表里的每个工具都有中文名（shared/tool-names.ts 集中维护）', () => {
  for (const n of PANEL_TOOL_NAMES) assert.ok(panelToolTitle(n), `${n} 没在 shared/tool-names.ts 登记中文名`)
})

test('没有专门写法的面板工具也显示中文名，不露出英文原名和 panel 标签', () => {
  // 用户报的：对话里显示「update_bug_case」带个 panel 标签
  const bug = toolView(tool('MCP', 'panel · update_bug_case', { input: '{"symptom":"点保存没反应"}' }))
  assert.equal(bug?.tool.name, '记 Bug 档案')
  assert.equal(bug?.tool.label, '点保存没反应')
  assert.equal(bug?.server, undefined)
  assert.equal(toolView(tool('mcp__agent-panel__remember', ''))?.tool.name, '记住一件事')
  assert.equal(toolView(tool('mcp__panel__list_workflows', ''))?.tool.name, '查看工作流运行')
})

test('插件服务（含旧版的 design 服务）的工具和服务名换成中文，别家的 MCP 照原样', () => {
  // 装着的插件按清单里的 mcpServers、toolNames 认（ADR 0059）
  setInstalledPlugins([
    PluginManifest.parse({
      id: 'blender',
      name: 'Blender',
      version: '1.0.0',
      mcpServers: ['blender'],
      toolNames: { blender_python: '执行 Blender 脚本' },
    }) as never,
    // UI 设计插件：旧对话里的 design 服务归它
    PluginManifest.parse({
      id: 'ui-design',
      name: 'UI 设计',
      version: '1.0.0',
      api: 4,
      mcpServers: ['design'],
      toolNames: { add_widgets: '添加控件', screenshot: '截取画布' },
    }) as never,
  ])
  const add = toolView(tool('MCP', 'design · add_widgets', { input: '{"parent":"Root"}' }))
  assert.deepEqual([add?.tool.name, add?.server], ['添加控件', 'UI 设计'])
  const py = toolView(tool('MCP', 'blender · blender_python', {}))
  assert.deepEqual([py?.tool.name, py?.server], ['执行 Blender 脚本', 'Blender'])
  const other = toolView(tool('MCP', 'notion · search', {}))
  assert.deepEqual([other?.tool.name, other?.server], ['search', 'notion'])
  // 别家服务里和面板同名的工具不按面板的叫法
  assert.equal(toolTitle('check', 'github'), 'check')
  assert.equal(serverTitle('agent-panel-3fa2c1'), '面板')
  assert.equal(serverTitle('agent-panel-design'), 'UI 设计')
})

test('「正在写」那一行用的原始名字也能查到中文名', () => {
  assert.equal(toolTitle('mcp__design__screenshot'), '截取画布')
  assert.equal(toolTitle('mcp__panel-142a58__update_bug_case'), '记 Bug 档案')
  assert.equal(toolTitle('mcp__notion__search'), 'search')
  assert.equal(toolTitle('Bash'), 'Bash')
})
