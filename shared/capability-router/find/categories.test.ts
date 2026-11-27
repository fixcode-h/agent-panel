/**
 * 查找按目标分类（用户 2026-11-27 定）：C++（项目和引擎）先走 VS、Lua 先走 IDEA、其他文件只走面板、看不出的先走面板。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGrepTool } from '../../tool-gateway/search-args.ts'
import { findRequestOfSearch } from '../../tool-gateway/takeover.ts'
import { categoryOf, findCategory } from './categories.ts'
import { findRequestOf } from './request.ts'

test('按扩展名认：代码归 C++ / Lua，别的扩展名都归其他文件', () => {
  assert.equal(categoryOf({ query: 'Foo', exts: ['lua'], dirs: [] }), 'lua')
  assert.equal(categoryOf({ query: 'Foo', exts: ['h', 'cpp'], dirs: [] }), 'cpp')
  assert.equal(categoryOf({ query: 'Foo', exts: ['json'], dirs: [] }), 'data')
  assert.equal(categoryOf({ query: 'Foo', exts: ['py'], dirs: [] }), 'data')
  assert.equal(categoryOf({ query: 'Foo', exts: [], dirs: [] }), 'other')
})

test('引擎目录（工作目录外的绝对路径）算 C++；脚本目录算 Lua；名字写法兜底', () => {
  assert.equal(categoryOf({ query: 'Foo', exts: [], dirs: ['C:/UE_5.4/Engine/Source/Runtime'] }), 'cpp')
  assert.equal(categoryOf({ query: 'Foo', exts: [], dirs: ['Source/Game'] }), 'cpp')
  assert.equal(categoryOf({ query: 'Foo', exts: [], dirs: ['Content/Script/UI'] }), 'lua')
  assert.equal(categoryOf({ query: 'A::B', exts: [], dirs: [] }), 'cpp')
  assert.equal(categoryOf({ query: 'A:B', exts: [], dirs: [] }), 'lua')
})

test('截图里的 Grep glob=*.json：归其他文件，只走面板', () => {
  const s = parseGrepTool({ pattern: 'TriggerPatrolNextPointGroup', path: 'Designer/ExcelTool', glob: '*.json' })!
  const req = findRequestOfSearch(s, ['Designer/ExcelTool'])
  assert.equal(req.lang, 'data')
  assert.equal(findCategory(req.lang).order, 'panel')
  // **/*.lua、*.{h,cpp} 这类通配也认得出扩展名
  const lua = parseGrepTool({ pattern: 'Foo', glob: '**/*.lua' })!
  assert.equal(findRequestOfSearch(lua, []).lang, 'lua')
  const cpp = parseGrepTool({ pattern: 'Foo', glob: '*.{h,cpp}' })!
  assert.equal(findRequestOfSearch(cpp, []).lang, 'cpp')
  // 搜单个文件按它的扩展名
  const one = parseGrepTool({ pattern: 'Foo', path: 'Config/DefaultGame.ini' })!
  assert.equal(findRequestOfSearch(one, ['Config/DefaultGame.ini']).lang, 'data')
})

test('find 工具：lang 可以写 data；include / members 看不出时按 C++', () => {
  const a = findRequestOf('text', { query: 'x', lang: 'data' })
  assert.ok(typeof a !== 'string' && a.lang === 'data')
  const b = findRequestOf('members', { query: 'Foo' })
  assert.ok(typeof b !== 'string' && b.lang === 'cpp')
  const c = findRequestOf('refs', { query: 'Foo' })
  assert.ok(typeof c !== 'string' && c.lang === 'other' && findCategory(c.lang).order === 'panel-first')
})
