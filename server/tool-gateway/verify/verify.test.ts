/**
 * 网关上的改完自动校验和改道接管（ADR 0086）：真起进程跑校验工具（node 脚本），核对一批改完只跑一次、同批不重复、
 * 只推报错、没报错不打扰、超时和起不来写清楚；改道模式下 luac 改用自建工具代答、UE 编译改用 request_build；收尾前补跑。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-verify-'))

const { openGateway } = await import('../gateway.ts')
const { clearCalls, recentCalls } = await import('../call-log.ts')
const { CustomTool } = await import('../../../shared/custom-tools/schema.ts')
const { customToolSigs } = await import('../../../shared/custom-tools/match.ts')

const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-verify-proj-'))
// 假的 Lua 检查：文件名带 bad 报一处错，带 slow 卡住不结束
const SCRIPT = `const f = process.argv[2] ?? ''
if (f.includes('slow')) setTimeout(() => {}, 60000)
else if (f.includes('bad')) { console.log('luac: ' + f + ':42: end expected'); process.exit(1) }
else console.log('ok ' + f)`
const tool = (id: string, command: string, over: Record<string, unknown> = {}) =>
  CustomTool.parse({
    id,
    name: id === 'lua-check' ? 'Lua 检查' : id,
    run: { command, script: { ext: 'mjs', text: SCRIPT }, timeoutSec: 30 },
    params: [{ name: 'file', type: 'path', required: true }],
    effect: 'read',
    output: { errorPattern: '^luac: (?<file>[^:]+):(?<line>\\d+): (?<msg>.*)$' },
    role: { kind: 'verify', paths: ['**/*.lua'], replaces: ['luac'] },
    ...over,
  })
const LUA = tool('lua-check', 'node {{script}} {{file}}')

const gateway = (mode: 'observe' | 'enforce', tools = [LUA], budgetSec?: number) =>
  openGateway({
    mode,
    task: { id: 't1', title: '对话' },
    projectId: 'p1',
    cliId: 'claude',
    spec: { searchTools: ['Grep'] },
    claimCtx: async () => ({
      customTools: customToolSigs(tools.map((t) => ({ scope: 'project' as const, file: '', tool: t }))),
      build: 'parent' as const,
    }),
    verify: {
      where: { projectId: 'p1', root },
      tools: async () => tools.map((t) => ({ tool: t, scope: 'project' as const })),
      budgetSec,
    },
  })!
const edit = (file: string) => ({
  tool: { kind: 'edit' as const, name: 'Edit', input: { file_path: file }, path: file, paths: [file] },
})
const bash = (command: string) => ({
  tool: { kind: 'shell' as const, name: 'Bash', input: { command }, path: '', paths: [] },
})
const read = (file: string) => ({
  tool: { kind: 'read' as const, name: 'Read', input: { file_path: file }, path: file, paths: [file] },
})
const verifyRows = () => recentCalls('p1').filter((r) => r.verify?.trigger === 'auto')

test('改完一批：去做别的事时跑一次，只推报错；同一批不重复；没报错不打扰', async () => {
  clearCalls()
  const on = gateway('observe').wrap(async () => ({}))
  // 连着改两个 Lua、一个 C++：改的时候不跑
  assert.deepEqual(await on('tool.before', edit(path.join(root, 'UI/bad.lua'))), {})
  assert.deepEqual(await on('tool.before', edit('UI/Shop.lua')), {})
  await on('tool.before', edit('Source/Bag.cpp'))
  assert.equal(verifyRows().length, 0)
  // 去读别的文件：跑一次，报错随这次工具前回答推回去
  const a = await on('tool.before', read('docs/README.md'))
  assert.match(a.context ?? '', /自建工具「Lua 检查」（lua-check）查了你刚改的 2 个文件，有 1 处报错/)
  assert.match(a.context ?? '', /UI\/bad\.lua:42: end expected/)
  const rows = verifyRows()
  assert.equal(rows.length, 1)
  assert.deepEqual(
    [rows[0].verify?.outcome, rows[0].verify?.errors, rows[0].verify?.files],
    ['errors', 1, ['UI/bad.lua', 'UI/Shop.lua']],
  )
  const trigger = recentCalls('p1').find((r) => r.tool === 'Read')
  assert.deepEqual(
    trigger?.pushes?.map((p) => p.id),
    ['verify:lua-check'],
  )
  // 同一批不再跑
  assert.deepEqual(await on('tool.before', bash('npm test')), {})
  assert.equal(verifyRows().length, 1)
  // 修好再改：通过了什么都不说，记录里是「通过」
  await on('tool.before', edit('UI/Shop.lua'))
  assert.deepEqual(await on('tool.before', bash('npm test')), {})
  assert.equal(verifyRows()[0].verify?.outcome, 'ok')
})

test('超时、工具起不来：写进说明和调用记录，不悄悄算通过', async () => {
  clearCalls()
  const slow = gateway('observe', [LUA], 2).wrap(async () => ({}))
  await slow('tool.before', edit('UI/slow.lua'))
  const a = await slow('tool.before', bash('git status'))
  assert.match(a.context ?? '', /超过限时，面板已停下：这批改动还没校验完/)
  assert.equal(verifyRows()[0].verify?.outcome, 'timeout')
  assert.equal(verifyRows()[0].failed, true)

  const missing = tool('lua-check', 'definitely-missing-lua-checker-xyz {{file}}')
  const gone = gateway('observe', [missing]).wrap(async () => ({}))
  await gone('tool.before', edit('UI/Shop.lua'))
  const b = await gone('tool.before', bash('git status'))
  assert.match(b.context ?? '', /没跑起来：程序找不到/)
  assert.match(b.context ?? '', /不是你的代码/)
  assert.equal(verifyRows()[0].verify?.outcome, 'spawn')
})

test('改道：luac 改用自建工具代答、UE 编译改用 request_build；观察模式只记会改到哪', async () => {
  clearCalls()
  const enforce = gateway('enforce').wrap(async () => ({ context: '原来的补充说明' }))
  const served = await enforce('tool.before', bash('luac -p UI/bad.lua'))
  assert.equal(served.deny, true)
  assert.match(served.reason ?? '', /^结果（面板）：你要跑的 luac -p UI\/bad\.lua 由面板改用项目的自建工具「Lua 检查」/)
  assert.match(served.reason ?? '', /UI\/bad\.lua:42: end expected/)
  const rec = recentCalls('p1')[0]
  assert.deepEqual(
    [rec.decision, rec.verify?.trigger, rec.wouldRoute?.to],
    ['serve', 'replaces', 'custom_tool:lua-check'],
  )

  const built = await enforce(
    'tool.before',
    bash('"D:/UE_5.4/Engine/Build/BatchFiles/Build.bat" ShopEditor Win64 Development'),
  )
  assert.equal(built.deny, true)
  assert.match(built.reason ?? '', /改用 request_build/)
  assert.equal(recentCalls('p1')[0].decision, 'redirect')

  const observe = gateway('observe').wrap(async () => ({}))
  assert.deepEqual(await observe('tool.before', bash('luac -p UI/bad.lua')), {})
  const o = recentCalls('p1')[0]
  assert.deepEqual([o.decision, o.wouldRoute?.decision], ['pass', 'serve'])
})

test('收尾前还有没查的改动：先跑，有报错拦下收尾并交回报错；查过的不再拦', async () => {
  clearCalls()
  const gw = gateway('observe')
  const on = gw.wrap(async () => ({}))
  const marks: string[] = []
  const end = gw.wrapEnd(
    async () => ({ block: false, why: 'inner' }),
    (r) => marks.push(r),
  )
  await on('tool.before', edit('UI/bad.lua'))
  const d = await end({})
  assert.equal(d.block, true)
  assert.match(d.reason ?? '', /1 处报错/)
  assert.equal(marks.length, 1)
  assert.deepEqual(await end({}), { block: false, why: 'inner' })
})
