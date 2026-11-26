/**
 * 工具网关的纯逻辑（ADR 0084）：命令类别、认调用、能力表推算改道、统计口径。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCommand } from './commands.ts'
import { classifyCall, readOnlyCall, splitMcpName } from './classify.ts'
import { decide } from './decide.ts'
import { filterCalls, gatewayStats, isSerial } from './stats.ts'
import type { CallRecord } from './types.ts'

test('命令类别：真实命令样本（含 Windows 写法、外壳、npx），多段的段数照实算', () => {
  const cases: [string, string | undefined, number][] = [
    // 搜索
    ['rg -n "OnSellAll" Content/Script', 'search', 1],
    ['grep -rn TODO src', 'search', 1],
    ['git grep -n BagPanel -- Source', 'search', 1],
    ['find . -name "*.lua"', 'search', 1],
    ['find . -iname bag*.h', 'search', 1],
    ['findstr /s /n OnSellAll *.lua', 'search', 1],
    ['cmd /c "findstr /s /i BagPanel *.h"', 'search', 1],
    ['powershell -NoProfile -Command "Select-String -Path src\\*.lua -Pattern \'Sell\'"', 'search', 1],
    ['Get-ChildItem -Recurse -Filter *.lua', 'search', 1],
    ['dir /s /b *.uasset', 'search', 1],
    ['bash -lc \'rg -l "x" web\'', 'search', 1],
    ['fd -e lua Bag', 'search', 1],
    // 不算搜索：find 不按名字找、只列目录
    ['find . -type f -newer a.txt', undefined, 1],
    ['ls -la', 'read', 1],
    // 检查
    ['luac -p Content/Script/UI/Bag.lua', 'lint', 1],
    ['npx eslint src', 'lint', 1],
    ['npm run lint', 'lint', 1],
    ['luacheck Content/Script', 'lint', 1],
    // 测试
    ['npm test', 'test', 1],
    ['npm run test:unit', 'test', 1],
    ['python -m pytest tests', 'test', 1],
    ['dotnet test', 'test', 1],
    ['go test ./...', 'test', 1],
    [
      '"D:/UE/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" Shop.uproject -ExecCmds="Automation RunTests Shop"',
      'test',
      1,
    ],
    // 编译
    ['& "D:/Program Files/UE_5.4/Engine/Build/BatchFiles/Build.bat" ShopEditor Win64 Development', 'build', 1],
    [
      '"G:/UE/Engine/Build/BatchFiles/Build.bat" ShopEditor Win64 Development -Project=G:/Shop/Shop.uproject',
      'build',
      1,
    ],
    ['UnrealBuildTool.exe ShopEditor Win64 Development', 'build', 1],
    ['msbuild Shop.sln /p:Configuration=Development', 'build', 1],
    ['dotnet build', 'build', 1],
    ['cmake --build build', 'build', 1],
    ['npm run build', 'build', 1],
    // 版本管理
    ['git status --short', 'vcs', 1],
    ['p4 edit Source/Shop/Bag.cpp', 'vcs', 1],
    ['svn update', 'vcs', 1],
    // 长命令
    ['npm ci', 'long', 1],
    ['npm run dev', 'long', 1],
    ['docker build .', 'long', 1],
    // 多段：管道、&&、;
    ['rg foo | head -20', 'search', 2],
    ['cd web && rg foo', 'search', 2],
    ['git add -A; git commit -m x', 'vcs', 2],
    // 读文件
    ['cat Content/UI/WBP_Bag.uasset', 'read', 1],
    ['Get-Content a.txt', 'read', 1],
    // 拿不准不归类
    ['node scripts/x.mjs', undefined, 1],
    ['echo hi', undefined, 1],
  ]
  for (const [cmd, cat, segs] of cases) {
    const p = parseCommand(cmd)
    assert.equal(p.category, cat, cmd)
    assert.equal(p.segments, segs, cmd)
  }
  assert.equal(parseCommand('& "D:/Program Files/UE/Engine/Build/BatchFiles/Build.bat" X').program, 'build')
  assert.equal(parseCommand('python -m pytest').program, 'pytest')
  // heredoc 正文里的命令不算段
  assert.equal(parseCommand("cat > a.md <<'EOF'\nrg foo | head\nEOF").segments, 1)
})

const tool = (
  kind: 'shell' | 'edit' | 'read' | 'panel' | 'any',
  name: string,
  input: Record<string, unknown>,
  panel = '',
) => ({
  kind,
  name,
  input,
  path: String(input.file_path ?? ''),
  paths: [],
  panel,
})
const ctx = { customTools: [{ id: 'lua-check', name: 'Lua 检查', sigs: ['luac'] }] }
const cli = { cli: 'claude', spec: { searchTools: ['Grep', 'Glob'] } }

test('认调用和能力推算：搜索改走 find，管道不改道，自建工具、读资源、UE 编译各归其位，被拒绝的不算', () => {
  const route = (t: ReturnType<typeof tool>) => decide(classifyCall(t, cli), ctx, false)
  const rg = route(tool('shell', 'Bash', { command: 'rg -n "OnSellAll" Content/Script' }))
  assert.deepEqual(rg.wouldRoute, { capability: 'find', decision: 'rewrite', to: 'find', by: 'rg' })
  // 管道：归 find，但不改道
  const piped = route(tool('shell', 'Bash', { command: 'rg foo | head' }))
  assert.equal(piped.capability, 'find')
  assert.equal(piped.wouldRoute, undefined)
  assert.equal(route(tool('read', 'Grep', { pattern: 'x' })).wouldRoute?.to, 'find')
  assert.equal(route(tool('read', 'Read', { file_path: 'a.lua' })).capability, undefined)
  // 外部查找工具：mcp__ 写法和调用方认出的裸名字
  assert.deepEqual(splitMcpName('mcp__ue_vs__search_symbols'), { server: 'ue_vs', tool: 'search_symbols' })
  assert.equal(route(tool('any', 'mcp__idea__lua_code', { action: 'search' })).wouldRoute?.to, 'find')
  const bare = classifyCall(tool('any', 'lua_code', {}), {
    ...cli,
    resolveMcp: () => ({ server: 'idea', tool: 'lua_code' }),
  })
  assert.equal(bare.kind, 'mcp')
  assert.equal(classifyCall(tool('any', 'whatever', {}), cli).kind, 'other')
  // 自建工具同一个程序 → custom_tool；没有对应自建工具的 luac -p 只归 verify
  assert.equal(route(tool('shell', 'Bash', { command: 'luac -p a.lua' })).wouldRoute?.to, 'custom_tool:Lua 检查')
  const noTool = decide(
    classifyCall(tool('shell', 'Bash', { command: 'luac -p a.lua' }), cli),
    { customTools: [] },
    false,
  )
  assert.equal(noTool.capability, 'verify')
  assert.equal(noTool.wouldRoute, undefined)
  // 读资源
  assert.equal(route(tool('read', 'Read', { file_path: 'Content/UI/WBP_Bag.uasset' })).wouldRoute?.to, 'ue_asset')
  assert.equal(route(tool('shell', 'Bash', { command: 'cat Maps/Main.umap' })).wouldRoute?.capability, 'read-asset')
  // UE 编译 → request_build；npm run build 不归面板的编译申请
  const ubt = route(
    tool('shell', 'PowerShell', {
      command: '& "D:/UE/Engine/Build/BatchFiles/Build.bat" ShopEditor Win64 Development',
    }),
  )
  assert.equal(ubt.wouldRoute?.to, 'request_build')
  assert.equal(route(tool('shell', 'Bash', { command: 'npm run build' })).capability, undefined)
  // 直接调面板的 find / request_build：归能力，不改道
  const find = route(tool('panel', 'mcp__panel__find', {}, 'find'))
  assert.equal(find.capability, 'find')
  assert.equal(find.wouldRoute, undefined)
  // 被拒绝的不执行，不算改道
  const denied = decide(classifyCall(tool('shell', 'Bash', { command: 'rg x' }), cli), ctx, true)
  assert.equal(denied.decision, 'deny')
  assert.equal(denied.wouldRoute, undefined)
  // 只读：读文件、搜索命令、面板查找；改文件、编译不算
  assert.ok(readOnlyCall(classifyCall(tool('read', 'Read', {}), cli)))
  assert.ok(readOnlyCall(classifyCall(tool('shell', 'Bash', { command: 'rg x' }), cli)))
  assert.ok(!readOnlyCall(classifyCall(tool('shell', 'Bash', { command: 'npm test' }), cli)))
  assert.ok(!readOnlyCall(classifyCall(tool('edit', 'Edit', {}), cli)))
})

const rec = (over: Partial<CallRecord>): CallRecord => ({
  id: Math.random().toString(36).slice(2),
  at: 0,
  projectId: 'p',
  taskId: 't',
  taskTitle: 'T',
  turn: 'u',
  cli: 'claude',
  tool: 'Read',
  kind: 'read',
  summary: '',
  input: '{}',
  decision: 'pass',
  ms: 0.1,
  ...over,
})

test('统计口径：各决定数、能改道比例、本可以并行（同一轮、上一个只读执行完才发）、推技能字数、网关耗时分位', () => {
  // 本可以并行
  const a = rec({ at: 1000, durMs: 50, readOnly: true })
  assert.ok(isSerial(a, rec({ at: 1100, readOnly: true })), '上一个结束后才发：串行')
  assert.ok(!isSerial(a, rec({ at: 1020, readOnly: true })), '上一个还没结束就发了：一起发的')
  assert.ok(!isSerial(a, rec({ at: 1100, readOnly: true, turn: 'v' })), '不同轮不比')
  assert.ok(!isSerial({ ...a, readOnly: false }, rec({ at: 1100, readOnly: true })), '中间是改文件、跑命令不算')
  assert.ok(!isSerial({ ...a, durMs: undefined }, rec({ at: 1100, readOnly: true })), '没收到工具后不算')

  const list = [
    rec({ at: 9, decision: 'deny', ms: 0.5, tool: 'Bash', summary: 'git push' }),
    rec({
      at: 8,
      wouldRoute: { capability: 'find', decision: 'rewrite', to: 'find', by: 'rg' },
      capability: 'find',
      ms: 0.2,
    }),
    rec({
      at: 7,
      serial: true,
      readOnly: true,
      skills: [{ skill: 'lua-code-style', chars: 2400, tokens: 1700 }],
      ms: 0.1,
    }),
    rec({ at: 6, error: 'boom', ms: 0.3, hookMs: 4 }),
  ]
  const s = gatewayStats(list, 200)
  assert.equal(s.total, 4)
  assert.equal(s.byDecision.deny, 1)
  assert.equal(s.byDecision.pass, 3)
  assert.equal(s.routable, 1)
  assert.equal(s.byCapability.find, 1)
  assert.equal(s.serial, 1)
  assert.equal(s.skills.tokens, 1700)
  assert.equal(s.skills.byTask[0].chars, 2400)
  assert.equal(s.errors, 1)
  assert.equal(s.ms.max, 0.5)
  assert.equal(s.ms.median, 0.2)
  assert.equal(s.ms.slowest?.summary, 'git push')
  assert.equal(s.ms.hook.median, 4)
  assert.equal(gatewayStats(list, 2).total, 2, '只取最近 N 条')
  // 筛选：能力按归属或会改到的算，搜索不分大小写
  assert.equal(filterCalls(list, { capability: 'find' }).total, 1)
  assert.equal(filterCalls(list, { q: 'GIT PUSH' }).total, 1)
  assert.equal(filterCalls(list, { decision: 'deny', limit: 1 }).items.length, 1)
})
