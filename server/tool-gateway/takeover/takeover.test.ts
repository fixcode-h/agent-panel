/**
 * 改道模式的查找接管接进网关（ADR 0084 第二期）：观察模式一字不改、改道模式按 CLI 定义改写或代答、
 * 改写的回答按 Claude Code 的钩子模板翻成 updatedInput、拿不准和出错都放行并记下原因、改写后的输入在工具后配得上。
 * 查找、照原样跑原命令、写打印脚本用假的。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-takeover-'))

const { openGateway } = await import('../gateway.ts')
const { clearCalls, recentCalls } = await import('../call-log.ts')
const { answerHook } = await import('../../hooks/bridge.ts')
const { getCli } = await import('../../../shared/clis.ts')
const { CliTakeover } = await import('../../../shared/tool-gateway/takeover-spec.ts')

const cwd = path.resolve('/proj')
const ROUTE = {
  capability: 'find',
  served: [{ source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp' as const }],
  steps: [
    { source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp' as const, outcome: 'used' as const, ms: 5 },
  ],
  ms: 5,
}
const HITS = [
  { file: 'Content/Script/UI/BagPanel.lua', line: 212, text: 'function BagPanel:OnSellAll()', rank: 0 as const },
  { file: 'Content/Script/UI/ShopPanel.lua', line: 41, text: 'Bag:Call("On" .. action)', rank: 1 as const },
]

function deps(over: Record<string, unknown> = {}) {
  const noted: string[] = []
  return {
    noted,
    d: {
      takeover: getCli('claude')!.takeover!,
      rewriteTpl: true,
      cwd,
      findCode: async () => ({ text: '', route: ROUTE, hits: HITS }),
      noteRoute: (_r: unknown, needle: string) => noted.push(needle),
      runOriginal: async () => 'Content/Script/UI/BagPanel.lua\n',
      writeScript: async () => 'C:/Temp/agent-panel-takeover/1.mjs',
      ...over,
    },
  }
}
const ctx = (mode: 'observe' | 'enforce', takeover: unknown) => ({
  mode,
  task: { id: 't1', title: '对话' },
  projectId: 'p1',
  cliId: 'claude',
  spec: { searchTools: ['Grep', 'Glob'] },
  claimCtx: async () => ({ customTools: [] }),
  takeover: takeover as never,
})
const bash = (command: string) => ({
  tool: { kind: 'shell' as const, name: 'Bash', input: { command, description: '' }, path: '', paths: [] },
})
const grep = (input: Record<string, unknown>) => ({
  tool: { kind: 'read' as const, name: 'Grep', input, path: '', paths: [] },
})
const inner = async () => ({ context: '这一块的教训……' })

test('观察模式一字不改；改道模式下 rg 改写成「先打印面板那段、再跑原命令」，按 Claude Code 的模板交出 updatedInput', async () => {
  clearCalls()
  const { d, noted } = deps()
  const cmd = 'rg -n "OnSellAll" Content/Script'
  const observe = openGateway(ctx('observe', d))!.wrap(inner)
  assert.deepEqual(await observe('tool.before', bash(cmd)), { context: '这一块的教训……' })
  assert.equal(recentCalls('p1')[0].decision, 'pass')

  const gw = openGateway(ctx('enforce', d))!
  const a = await gw.wrap(inner)('tool.before', bash(cmd))
  assert.equal(a.rewrite?.command, `node "C:/Temp/agent-panel-takeover/1.mjs"; ${cmd}`)
  assert.equal(a.rewrite?.description, '', '其余字段原样带上')
  assert.equal(a.context, '这一块的教训……', '守卫、推送补的说明照样交出去')
  const r = recentCalls('p1')[0]
  assert.equal(r.decision, 'rewrite')
  assert.equal(r.route?.from, cmd)
  assert.match(r.rewritten ?? '', /agent-panel-takeover/)
  assert.deepEqual(noted, [cmd], '工具卡片按命令原文认那一行')

  // 工具后：CLI 报的是改写后的输入，照样配得上
  await gw.wrap(async () => ({}))('tool.after', { tool: { ...bash(cmd).tool, input: a.rewrite! } })
  assert.ok(recentCalls('p1')[0].durMs !== undefined)

  // Claude Code 的钩子输出：permissionDecision=allow + updatedInput 是整份改写后的输入
  const out = await answerHook({ spec: getCli('claude')!.hooks!, on: async () => a }, 'tool.before', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: cmd },
  })
  const hso = (out.output as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput
  assert.equal(hso.permissionDecision, 'allow')
  assert.deepEqual(hso.updatedInput, a.rewrite)
  assert.equal(hso.additionalContext, '这一块的教训……')
})

test('不能改写的 CLI、自带 Grep 走代答：拒绝说明开头只写「结果（面板）」，原命令的输出原样在里面', async () => {
  clearCalls()
  const { d } = deps({ takeover: CliTakeover.parse({}), rewriteTpl: false })
  const onHook = openGateway(ctx('enforce', d))!.wrap(inner)
  const a = await onHook('tool.before', bash('rg -n OnSellAll Content/Script'))
  assert.equal(a.deny, true)
  assert.match(a.reason ?? '', /^结果（面板）\n/)
  assert.ok(!/拦截/.test(a.reason ?? ''))
  assert.match(a.reason ?? '', /Content\/Script\/UI\/BagPanel\.lua\n/)
  assert.match(a.reason ?? '', /这一块的教训/)
  assert.equal(recentCalls('p1')[0].decision, 'serve')

  const { d: d2, noted } = deps()
  const b = await openGateway(ctx('enforce', d2))!.wrap(inner)(
    'tool.before',
    grep({ pattern: 'OnSellAll', path: 'Content' }),
  )
  assert.equal(b.deny, true, 'Grep 换不成 shell：Claude Code 也只能代答')
  assert.deepEqual(noted, ['"OnSellAll"'])
})

test('拿不准、面板跑不出原命令、没有多出来的、网关出错：都放行，原回答原样交回并记下原因', async () => {
  clearCalls()
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [{}, 'rg -n OnSellAll src | head', /多段命令/],
    [{}, 'rg "On.*All" src', /参数拿不准/],
    [{ findCode: async () => ({ text: '', route: ROUTE, hits: [] }) }, 'rg -n OnSellAll src', /没有多出来的/],
    [
      { takeover: CliTakeover.parse({}), rewriteTpl: false, runOriginal: async () => undefined },
      'rg -n OnSellAll src',
      /没能照原样跑/,
    ],
    [{ findCode: async () => ({ text: '查找出错：服务挂了', error: true }) }, 'rg -n OnSellAll src', /服务挂了/],
    [{}, 'rg -n OnSellAll ../other', /不在对话的工作目录/],
    [{ findCode: async () => Promise.reject(new Error('炸了')) }, 'rg -n OnSellAll src', /网关出错/],
  ]
  for (const [over, cmd, why] of cases) {
    const a = await openGateway(ctx('enforce', deps(over).d))!.wrap(inner)('tool.before', bash(cmd))
    assert.deepEqual(a, { context: '这一块的教训……' }, cmd)
    const r = recentCalls('p1')[0]
    assert.equal(r.decision, 'pass', cmd)
    assert.match(r.takeoverWhy ?? '', why, cmd)
  }
  assert.equal(recentCalls('p1')[0].error, '炸了')
})
