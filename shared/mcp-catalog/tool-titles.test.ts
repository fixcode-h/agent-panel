import assert from 'node:assert/strict'
import test from 'node:test'
import { externalToolTitle, setMcpToolTitles, titleOfTool } from './tool-titles.ts'
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
