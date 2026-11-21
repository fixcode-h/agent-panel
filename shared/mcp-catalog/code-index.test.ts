import assert from 'node:assert/strict'
import test from 'node:test'
import { briefDesc, codeIndexLines, ideMcpLines, isCodeIndexTool, parseCodeIndexItem } from './code-index.ts'

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

test('JetBrains IDE 服务：参数规矩按缓存的参数表写，没有参数表时不点名参数；开了仅路由器时写明 execute_tool 的 --参数名 值', () => {
  assert.deepEqual(ideMcpLines(undefined), [])
  // 还没问过服务：只写照工具自己的参数表传，不手写 projectPath（#398：Agent 照着给 lua_code 也传了）
  const plain = ideMcpLines([{ server: 'idea' }]).join('\n')
  assert.match(plain, /`idea` 是 JetBrains IDE/)
  assert.match(plain, /照这个工具自己的参数表传/)
  assert.doesNotMatch(plain, /projectPath|lua_code|execute_tool/)
  // 有参数表：点名有 projectPath 的和用 project 的
  const params = {
    search_in_files_by_text: [
      { name: 'searchText', type: 'string', required: true as const },
      { name: 'projectPath', type: 'string' },
    ],
    lua_code: [
      { name: 'action', type: 'search | files | outline | references', required: true as const },
      { name: 'query', type: 'string' },
      { name: 'project', type: 'string' },
    ],
  }
  const known = ideMcpLines([{ server: 'idea', params }]).join('\n')
  assert.match(
    known,
    /`projectPath` 只有参数表里列了它的工具才传（`search_in_files_by_text`）；`lua_code` 没有它[^\n]*`project`/,
  )
  assert.match(known, /Currently open projects/)
  // 参数表里谁都没有 projectPath：不提它
  assert.doesNotMatch(
    ideMcpLines([{ server: 'idea', params: { lua_code: params.lua_code } }]).join('\n'),
    /projectPath/,
  )
  // 仅路由器：例子从参数表里挑（lua_code 的 action 第一个取值）
  const router = ideMcpLines([{ server: 'idea', router: true, params }]).join('\n')
  assert.match(router, /`lua_code --action search`/)
  assert.match(router, /不要写成 `参数名=值`/)
  assert.doesNotMatch(ideMcpLines([{ server: 'idea', router: true }]).join('\n'), /例如/)
})

test('代码索引工具：登记过用途的认得出（正则认不出的 get_members、suggest_include、lua_code），写东西的照旧不算', () => {
  for (const n of [
    'get_members',
    'suggest_include',
    'get_reflection_info',
    'get_module_info',
    'lua_code',
    'get_file_outline',
  ])
    assert.equal(isCodeIndexTool(n), true, n)
  assert.equal(isCodeIndexTool('rename_symbol'), false)
})

test('代码索引工具：按用途分组列出，登记过的写什么时候用，有看签名的工具时提醒写调用前先核对', () => {
  const text = codeIndexLines([
    { server: 'uetovs', tool: 'suggest_include', desc: 'x' },
    { server: 'uetovs', tool: 'get_members' },
    { server: 'uetovs', tool: 'search_symbols' },
    { server: 'other', tool: 'search_code', desc: '陌生服务的说明' },
  ]).join('\n')
  // 组的顺序：找 → 看签名 → include
  const find = text.indexOf('找声明和文件')
  const shape = text.indexOf('看结构和签名')
  const deps = text.indexOf('include 和模块依赖')
  assert.ok(find >= 0 && find < shape && shape < deps, text)
  assert.match(text, /`get_members`：列一个类的成员和签名/)
  assert.match(text, /other 服务的 `search_code`：陌生服务的说明/)
  assert.match(text, /不凭记忆写/)
  assert.doesNotMatch(codeIndexLines([{ server: 'uetovs', tool: 'search_symbols' }]).join('\n'), /不凭记忆写/)
})
