import assert from 'node:assert/strict'
import test from 'node:test'
import { briefDesc, codeIndexLines, isCodeIndexTool, parseCodeIndexItem } from './code-index.ts'

test('代码索引工具：按名字认出搜符号、搜 Lua 这类，写东西和跑东西的不算', () => {
  for (const n of ['search_lua', 'search_symbols', 'find_references', 'search_files', 'goto_definition', 'symbols'])
    assert.equal(isCodeIndexTool(n), true, n)
  for (const n of ['build_project', 'edit_file', 'run_lua', 'search_web', 'list_assets', 'update_symbol'])
    assert.equal(isCodeIndexTool(n), false, n)
})

test('代码索引工具：说明只取第一句，手动指定写成 服务名/工具名', () => {
  assert.equal(briefDesc('Search Lua symbols by name. Returns file and line.'), 'Search Lua symbols by name.')
  assert.equal(briefDesc('  '), undefined)
  assert.deepEqual(parseCodeIndexItem(' uetovs/search_lua '), { server: 'uetovs', tool: 'search_lua' })
  assert.equal(parseCodeIndexItem('search_lua'), undefined)
})

test('代码索引工具：认出了就逐个列出服务和工具名，没认出也提醒先用', () => {
  const listed = codeIndexLines([{ server: 'uetovs', tool: 'search_lua', desc: '按名字搜 Lua 符号' }]).join('\n')
  assert.match(listed, /uetovs 服务的 `search_lua`：按名字搜 Lua 符号/)
  assert.match(listed, /先加载它的说明/)
  assert.match(codeIndexLines(undefined).join('\n'), /没认出代码索引工具[^\n]*search_lua/)
})
