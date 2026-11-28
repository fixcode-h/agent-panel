/**
 * 校验和改动生效的判定（ADR 0086）：一批改动怎么记、怎么取；replaces 按真实命令样本认；改道时代答还是改用、
 * 编译改用 request_build 时说明怎么写；只推报错、没报错不打扰。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CustomTool } from '../../custom-tools/schema.ts'
import { customToolFor, customToolSigs } from '../../custom-tools/match.ts'
import { draftProblems } from '../../custom-tools/expand.ts'
import { classifyCall } from '../classify.ts'
import { decide } from '../decide.ts'
import { newBatch, noteEdits, takeBatch } from './batch.ts'
import { takeoverPlan } from './plan.ts'
import { redirectText, serveText, verifyNote, type VerifyOutput } from './text.ts'
import type { VerifyRun } from './types.ts'

const luaCheck = CustomTool.parse({
  id: 'lua-check',
  name: 'Lua 检查',
  run: { command: 'python tools/lua_check.py {{file}}' },
  params: [{ name: 'file', type: 'path', required: true }],
  effect: 'read',
  role: { kind: 'verify', paths: ['**/*.lua'], replaces: ['luac', 'luacheck.exe'] },
})
const ubtTool = CustomTool.parse({
  id: 'ue-build',
  name: '编译',
  run: { command: 'tools/build.bat {{target}}' },
  params: [{ name: 'target', required: true }],
  role: { kind: 'build' },
})
const exportTables = CustomTool.parse({
  id: 'export-tables',
  name: '导表',
  run: { command: 'python tools/export_tables.py' },
})
const entries = [luaCheck, ubtTool, exportTables].map((tool) => ({ scope: 'project' as const, file: '', tool }))
const sigs = customToolSigs(entries)
const shell = (command: string) =>
  classifyCall(
    { kind: 'shell', name: 'Bash', input: { command }, path: '', paths: [] },
    { cli: 'claude', spec: { searchTools: [] } },
  )

test('一批改动：只记对得上 paths 的，同一个文件记一次，取走后清空（同批不重复跑）', () => {
  const b = newBatch()
  const targets = [{ id: 'lua-check', paths: ['**/*.lua'] }]
  assert.equal(noteEdits(b, ['Content/Script/UI/Bag.lua', 'Source/Bag.cpp'], targets), 1)
  assert.equal(noteEdits(b, ['Content\\Script\\UI\\Bag.lua', './Content/Script/Shop.lua'], targets), 1)
  assert.deepEqual(takeBatch(b), [
    { tool: 'lua-check', files: ['Content/Script/UI/Bag.lua', 'Content/Script/Shop.lua'] },
  ])
  assert.deepEqual(takeBatch(b), [], '取走后再取是空的')
})

test('replaces 按真实命令样本认：luac、带路径和 .exe 的、自建工具自己的脚本；编译工具和普通工具各归其位', () => {
  const route = (cmd: string) => decide(shell(cmd), { customTools: sigs }, false).wouldRoute
  // 能代答：只读、命令里找得到 .lua 文件
  assert.deepEqual(route('luac -p Content/Script/UI/Bag.lua'), {
    capability: 'verify',
    decision: 'serve',
    to: 'custom_tool:lua-check',
    by: 'luac',
  })
  assert.equal(route('"C:/Tools/Lua/luac.exe" -p Bag.lua')?.to, 'custom_tool:lua-check')
  assert.equal(route('luacheck.exe Content/Script/Shop.lua')?.to, 'custom_tool:lua-check')
  assert.equal(route('python tools/lua_check.py Content/Script/Shop.lua')?.decision, 'serve')
  // 命令里没有文件、管道：不代答
  assert.equal(route('luac -v')?.decision, 'redirect')
  assert.equal(route('luac -p a.lua 2>&1 | head')?.decision, undefined)
  // 会改文件的普通工具：只改用（要过授权卡）
  assert.equal(route('python tools/export_tables.py Item')?.decision, 'redirect')
  // role=build 的工具归改动生效
  const own = route('tools/build.bat ShopEditor')
  assert.deepEqual([own?.capability, own?.decision, own?.to], ['apply', 'redirect', 'custom_tool:ue-build'])
  // 情境规则 custom-tool-instead（观察模式的提醒）也认 replaces
  assert.equal(customToolFor('cd Content && luac -p a.lua', sigs)?.id, 'lua-check')
})

test('UE 编译：挂了 request_build 改用它，没挂时退到 role=build 的工具；说明写清参数', () => {
  const ue = '& "D:/UE_5.4/Engine/Build/BatchFiles/Build.bat" ShopEditor Win64 Development'
  const withBuild = decide(shell(ue), { customTools: sigs, build: 'parent' }, false).wouldRoute
  assert.deepEqual([withBuild?.capability, withBuild?.decision, withBuild?.to], ['apply', 'redirect', 'request_build'])
  assert.equal(
    decide(shell('msbuild Shop.sln'), { customTools: [], build: 'child' }, false).wouldRoute?.to,
    'request_build',
  )
  assert.equal(decide(shell(ue), { customTools: sigs }, false).wouldRoute?.to, 'custom_tool:ue-build')
  assert.equal(decide(shell(ue), { customTools: [] }, false).wouldRoute, undefined, '两条路都没有：只归类')

  const parent = takeoverPlan(shell(ue), { customTools: sigs, build: 'parent' }, withBuild)
  assert.equal(parent?.kind, 'redirect')
  assert.match(parent?.kind === 'redirect' ? parent.text : '', /改用 request_build.*note.*children/)
  assert.match(redirectText('request_build', { customTools: [], build: 'child' }, ue), /向父对话申请编译/)
  assert.match(redirectText('custom_tool:lua-check', { customTools: sigs }, 'luac -v'), /id=lua-check args=\{"file"/)
  // 代答：文件从命令里取；别的能力不归这里管
  const serve = takeoverPlan(
    shell('luac -p a.lua b.lua'),
    { customTools: sigs },
    {
      capability: 'verify',
      decision: 'serve',
      to: 'custom_tool:lua-check',
      by: 'luac',
    },
  )
  assert.deepEqual(serve, { kind: 'serve', tool: 'lua-check', files: ['a.lua', 'b.lua'] })
  assert.equal(
    takeoverPlan(
      shell('rg x'),
      { customTools: sigs },
      { capability: 'find', decision: 'rewrite', to: 'find', by: 'rg' },
    ),
    undefined,
  )
})

const out = (over: Partial<VerifyRun>, errors: VerifyOutput['errors'] = [], tail: string[] = []): VerifyOutput => ({
  run: {
    trigger: 'auto',
    tool: 'lua-check',
    name: 'Lua 检查',
    files: ['Shop.lua'],
    outcome: 'ok',
    errors: errors.length,
    ms: 120,
    ...over,
  },
  errors,
  tail,
})

test('只推报错：通过时什么都不说；报错、超时、起不来都写清楚怎么办；代答开头写「结果（面板）」', () => {
  assert.equal(verifyNote([out({})]), '', '没报错不打扰')
  const errs = verifyNote([out({ outcome: 'errors' }, [{ file: 'Shop.lua', line: 42, msg: "'end' expected" }])])
  assert.match(errs, /Shop\.lua:42: 'end' expected/)
  assert.match(errs, /1 处报错，先改好再继续/)
  assert.match(verifyNote([out({ outcome: 'timeout', note: '限时 45 秒' })]), /超过限时.*还没校验完/)
  const spawn = verifyNote([out({ outcome: 'spawn', note: 'spawn python ENOENT' })])
  assert.match(spawn, /没跑起来：spawn python ENOENT/)
  assert.match(spawn, /不是你的代码/)
  assert.match(verifyNote([out({ outcome: 'failed' }, [], ['luac: bad'])]), /没通过.*\n.*luac: bad/)
  assert.match(serveText('luac -p Shop.lua', [out({})]), /^结果（面板）：.*通过，没有报错/s)
  // 代答时把什么时候用、怎么调写给 Agent，下次不再自己拼 luac
  assert.match(
    serveText('luac -p Shop.lua', [out({})], { useWhen: '改完 .lua 文件后', arg: 'files' }),
    /以后遇到同样的事（改完 \.lua 文件后）直接调 tool_lua_check（参数 \{"files": "<要查的文件>"\}）/,
  )
  // 校验工具必须只读、写 paths
  assert.ok(draftProblems({ ...luaCheck, effect: 'write' }).some((p) => p.includes('要是只读的')))
  assert.ok(
    draftProblems({ ...luaCheck, role: { ...luaCheck.role!, paths: [] } }).some((p) => p.includes('role.paths')),
  )
})
