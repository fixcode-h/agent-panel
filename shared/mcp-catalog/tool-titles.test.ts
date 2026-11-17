import assert from 'node:assert/strict'
import test from 'node:test'
import { externalToolTitle, setMcpToolTitles, splitZhTitleLine, titleOfTool } from './tool-titles.ts'
import { toolTitle } from '../tool-names.ts'
import { setLang } from '../i18n.ts'

test('tools/list 的显示名：title 或 annotations.title，_meta.titles 的语言按前两个字母认', () => {
  assert.deepEqual(
    titleOfTool({
      name: 'search_symbols',
      title: 'Search C++ symbols',
      _meta: { titles: { 'zh-CN': '搜索 C++ 符号' } },
    }),
    { title: 'Search C++ symbols', titles: { zh: '搜索 C++ 符号' } },
  )
  assert.deepEqual(titleOfTool({ name: 'x', annotations: { title: 'X' } }), { title: 'X' })
  assert.equal(titleOfTool({ name: 'x', _meta: { titles: { zh: '  ' } } }), undefined)
})

test('别家服务的工具行按界面语言显示服务报的名字，没报的照原名，面板自己的服务不受影响', () => {
  setMcpToolTitles({
    uetovs: {
      search_symbols: { title: 'Search C++ symbols', titles: { zh: '搜索 C++ 符号', en: 'Search C++ symbols' } },
      index_status: { title: 'Index status' },
    },
  })
  setLang('zh')
  assert.equal(toolTitle('search_symbols', 'uetovs'), '搜索 C++ 符号')
  assert.equal(toolTitle('mcp__uetovs__search_symbols'), '搜索 C++ 符号')
  // 中文名没报：退回服务给的 title
  assert.equal(toolTitle('index_status', 'uetovs'), 'Index status')
  assert.equal(toolTitle('find_references', 'uetovs'), 'find_references')
  assert.equal(externalToolTitle('notion', 'search'), '')
  setLang('en')
  assert.equal(toolTitle('search_symbols', 'uetovs'), 'Search C++ symbols')
  setLang('zh')
  setMcpToolTitles({})
})

test('JetBrains IDE 服务没报中文名时用面板备好的，服务报了中文名以服务的为准', async () => {
  const { proxiedTool } = await import('./proxy-tool.ts')
  setLang('zh')
  assert.equal(toolTitle('build_project', 'idea'), '编译项目')
  assert.equal(toolTitle('mcp__rider__search_symbol'), '搜索符号')
  assert.equal(toolTitle('build_project', 'other'), 'build_project')
  setMcpToolTitles({ idea: { build_project: { title: 'Build', titles: { zh: '构建' } } } })
  assert.equal(toolTitle('build_project', 'idea'), '构建')
  setMcpToolTitles({})
  setLang('en')
  assert.equal(toolTitle('build_project', 'idea'), 'build_project')
  setLang('zh')
  assert.deepEqual(proxiedTool('execute_tool', { command: 'read_file path=a.lua' }), {
    tool: 'read_file',
    arg: 'path=a.lua',
  })
  assert.deepEqual(proxiedTool('call_tool', { tool_name: 'x', arguments: { q: 'hi' } }), { tool: 'x', arg: 'hi' })
  assert.equal(proxiedTool('read_file', { command: 'x' }), undefined)
  assert.equal(proxiedTool('execute_tool', { command: '{"bad": 1}' }), undefined)
})

test('IDE 服务不转发 _meta 时，从说明最后一行「Title (zh): …」认中文名，并从说明里去掉这一行', () => {
  const description = 'Lua debug session.\nUSE FIRST WHEN: x\nTitle (zh): Lua 调试：会话与单步'
  assert.deepEqual(splitZhTitleLine(description), {
    description: 'Lua debug session.\nUSE FIRST WHEN: x',
    zh: 'Lua 调试：会话与单步',
  })
  assert.equal(splitZhTitleLine('Title (zh): 旧名\nmore\nTitle (zh): 新名\n').zh, '新名')
  assert.deepEqual(splitZhTitleLine('no title line'), { description: 'no title line' })
  assert.deepEqual(titleOfTool({ name: 'lua_debug_session', description }), { titles: { zh: 'Lua 调试：会话与单步' } })
  // _meta.titles 报了中文名时以它为准
  assert.deepEqual(titleOfTool({ name: 'x', description, _meta: { titles: { zh: '别的名' } } }), {
    titles: { zh: '别的名' },
  })
  // 插件新起的工具不在面板的表里，也能显示中文名
  setMcpToolTitles({ idea: { lua_debug_new: titleOfTool({ name: 'lua_debug_new', description })! } })
  setLang('zh')
  assert.equal(toolTitle('lua_debug_new', 'idea'), 'Lua 调试：会话与单步')
  setMcpToolTitles({})
})
