import assert from 'node:assert/strict'
import test from 'node:test'
import { briefParams, PARAMS_MAX, paramTableText, parseParams, resolveMcpTool } from './tool-params.ts'

test('参数表：只存名字、类型、必填，超长时先截长枚举、再丢可选参数，必填的不丢', () => {
  const small = briefParams([
    { name: 'action', type: 'search | files', description: '很长的说明不存', required: true },
    { name: 'query', type: 'string', description: '', required: false },
  ])
  assert.deepEqual(small, [
    { name: 'action', type: 'search | files', required: true },
    { name: 'query', type: 'string' },
  ])
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `p${i}`,
    type: 'string',
    description: '',
    required: i === 39,
  }))
  const cut = briefParams(many)
  assert.ok(JSON.stringify(cut).length <= PARAMS_MAX)
  assert.equal(cut[0].name, 'p39', '必填的排前面留着')
  assert.equal(paramTableText(small), 'action（必填）：search | files、query：string')
  assert.equal(paramTableText([]), '不带参数')
  assert.deepEqual(parseParams([{ name: 'a', type: 1 }, { type: 'x' }, 'bad']), [{ name: 'a', type: 'any' }])
  assert.equal(parseParams('x'), undefined)
})

test('认工具：各家前缀写法都按「以工具名结尾、带着服务名」认，裸名字在几个服务里都有时不猜', () => {
  const servers = [
    { server: 'idea', names: ['lua_code', 'execute_tool'] },
    { server: 'uetovs', names: ['search_symbols', 'search_files'] },
    { server: 'rider', names: ['search_files'] },
  ]
  assert.deepEqual(resolveMcpTool('mcp__idea__lua_code', {}, servers), { server: 'idea', tool: 'lua_code' })
  assert.deepEqual(resolveMcpTool('uetovs_search_symbols', {}, servers), { server: 'uetovs', tool: 'search_symbols' })
  assert.deepEqual(resolveMcpTool('search_symbols', {}, servers), { server: 'uetovs', tool: 'search_symbols' })
  assert.equal(resolveMcpTool('search_files', {}, servers), undefined)
  assert.deepEqual(resolveMcpTool('mcp__rider__search_files', {}, servers), { server: 'rider', tool: 'search_files' })
  assert.equal(resolveMcpTool('mcp__other__thing', {}, servers), undefined)
  // 仅路由器转调
  assert.deepEqual(resolveMcpTool('mcp__idea__execute_tool', { command: 'lua_code --action search' }, servers), {
    server: 'idea',
    tool: 'lua_code',
  })
})
