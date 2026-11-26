/**
 * 情境规则（D1）：按工具调用和面板状态匹配，每条一个对话只推一次，条数有上限。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelSupportData, resolveSupport } from '../models/support.ts'
import type { HookFacts } from './index.ts'
import { pickSituational, situationMatches, SITUATIONAL_RULES, type SituationCtx } from './situational.ts'

const edit: HookFacts = { tool: { kind: 'edit', name: 'Edit', input: {}, path: 'src/a.ts', paths: ['src/a.ts'] } }
const read: HookFacts = { tool: { kind: 'read', name: 'Read', input: {}, path: 'src/a.ts', paths: ['src/a.ts'] } }
const weak = resolveSupport(ModelSupportData.parse({}), 'low')
const strong = resolveSupport(ModelSupportData.parse({}), 'high')
const ctx = (o: Partial<SituationCtx> = {}): SituationCtx => ({
  event: 'tool.before',
  facts: edit,
  task: { plans: [] },
  support: weak,
  plans: true,
  ...o,
})
const rule = SITUATIONAL_RULES.find((r) => r.id === 'impl-plan-first')!

test('情境规则：弱模型第一次改文件前没计划才推「先列实现计划」', () => {
  assert.ok(situationMatches(rule, ctx()))
  // 强模型、读文件、没有计划工具、已经有计划：都不推
  assert.equal(situationMatches(rule, ctx({ support: strong })), false)
  assert.equal(situationMatches(rule, ctx({ facts: read })), false)
  assert.equal(situationMatches(rule, ctx({ plans: false })), false)
  const plan = { id: 'p', steps: [], createdAt: '', updatedAt: '' }
  assert.equal(situationMatches(rule, ctx({ task: { plans: [plan] as never } })), false)
})

test('情境规则：每条一个对话只推一次，一次最多推 limit 条', () => {
  const told = new Map<string, number>()
  assert.equal(pickSituational(ctx(), told, 3).length, 1)
  assert.equal(pickSituational(ctx(), told, 3).length, 0)
  const many = ['a', 'b', 'c'].map((id) => ({
    id,
    name: () => id,
    when: { event: 'tool.before' as const },
    text: () => id,
  }))
  assert.deepEqual(
    pickSituational(ctx(), new Map(), 2, many).map((x) => x.id),
    ['a', 'b'],
  )
})

test('情境规则：按路径和报错匹配', () => {
  const r = {
    id: 'cpp',
    name: () => 'cpp',
    when: { event: 'tool.after' as const, paths: ['**/*.cpp'], failed: true, error: /C2039/ },
    text: () => 'x',
  }
  const f = (path: string, output: string, failed = true): HookFacts => ({
    tool: { kind: 'shell', name: 'Bash', input: {}, path, paths: [path], result: { output, failed } },
  })
  assert.ok(situationMatches(r, ctx({ event: 'tool.after', facts: f('Source/A.cpp', 'error C2039: x') })))
  assert.equal(situationMatches(r, ctx({ event: 'tool.after', facts: f('Source/A.h', 'error C2039') })), false)
  assert.equal(situationMatches(r, ctx({ event: 'tool.after', facts: f('Source/A.cpp', 'ok', false) })), false)
  assert.equal(situationMatches(r, ctx({ event: 'tool.after', facts: f('Source/A.cpp', 'error C3861') })), false)
})

test('情境规则：第一次调 JetBrains IDE 服务的工具时推它的调用规矩（参数照缓存的参数表），别的 MCP 不推', () => {
  const ide = SITUATIONAL_RULES.find((r) => r.id === 'ide-mcp-rules')!
  const call = (name: string): HookFacts => ({ tool: { kind: 'any', name, input: {}, path: '', paths: [] } })
  const ideMcp = [
    {
      server: 'idea',
      router: true,
      params: { lua_code: [{ name: 'action', type: 'search | files', required: true }] },
    },
  ]
  const c = ctx({ facts: call('mcp__idea__lua_code'), ideMcp: ideMcp as never })
  assert.ok(situationMatches(ide, c))
  assert.match(ide.text(c), /execute_tool[\s\S]*lua_code --action search/)
  assert.equal(situationMatches(ide, ctx({ facts: call('mcp__uetovs__search_lua'), ideMcp: ideMcp as never })), false)
  assert.equal(situationMatches(ide, ctx({ facts: call('mcp__idea__lua_code') })), false)
})

test('情境规则：第一次改 Lua / C++ 文件前推对应的代码风格要点（Windows 绝对路径也认）', () => {
  const lua = SITUATIONAL_RULES.find((r) => r.id === 'code-style:lua-code-style')!
  const cpp = SITUATIONAL_RULES.find((r) => r.id === 'code-style:cpp-code-style')!
  const at = (p: string, kind: 'edit' | 'read' = 'edit'): HookFacts => ({
    tool: { kind, name: 'Edit', input: {}, path: p, paths: [p] },
  })
  const winLua = 'G:\\Project\\Content\\Script\\Module\\s_BW_CG_ClinkGlassesSystem.lua'
  assert.ok(situationMatches(lua, ctx({ facts: at(winLua), support: strong })))
  assert.ok(situationMatches(lua, ctx({ facts: at('Script/a.lua'), support: strong, plans: false })))
  assert.equal(situationMatches(lua, ctx({ facts: at('Script/a.lua', 'read') })), false)
  assert.equal(situationMatches(lua, ctx({ facts: at('src/a.ts') })), false)
  assert.ok(situationMatches(cpp, ctx({ facts: at('Source/Foo/Private/Foo.cpp') })))
  const text = lua.text(ctx({ facts: at(winLua) }))
  assert.match(text, /lua-code-style/)
  assert.match(text, /日志调用都不拆成续行/)
})

test('情境规则：自己拼命令跑自建工具包好的程序时提醒改用 custom_tool', () => {
  const r = SITUATIONAL_RULES.find((x) => x.id === 'custom-tool-instead')!
  const sh = (command: string): HookFacts => ({
    tool: { kind: 'shell', name: 'Bash', input: { command }, path: '', paths: [] },
  })
  const customTools = [{ id: 'lua-check', name: 'Lua 语法检查', sigs: ['luac'] }]
  assert.ok(situationMatches(r, ctx({ facts: sh('D:/Tools/luac.exe -p a.lua b.lua'), customTools })))
  assert.ok(situationMatches(r, ctx({ facts: sh('cd x && luac -p a.lua'), customTools })))
  assert.equal(situationMatches(r, ctx({ facts: sh('luacheck a.lua'), customTools })), false)
  assert.equal(situationMatches(r, ctx({ facts: sh('luac -p a.lua') })), false)
  assert.match(r.text(ctx({ facts: sh('luac -p a.lua'), customTools })), /custom_tool action=run id=lua-check/)
})
