/**
 * ExposurePolicy（ADR 0085）：哪些外部服务经面板代理、哪些退回直接挂、哪些工具被能力接管不给 Agent；
 * 代理的外部工具收在 more_tools 后面（名字「服务/工具」），定义长度不随外部工具变多而超 ADR 0067 的上限。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { splitDeferred } from '../panel-tools.ts'
import { exposurePlan, externalClaims, shownProxied, type ExposureInput } from './exposure.ts'
import { proxiedCallOf, unwrapProxied } from './names.ts'

const input = (over: Partial<ExposureInput> = {}): ExposureInput => ({
  enabled: true,
  cliCan: true,
  panel: true,
  panelTools: ['find', 'end_turn'],
  servers: [
    { name: 'idea', source: '.mcp.json', state: 'ok', tools: ['lua_code', 'lua_debug_session'] },
    { name: 'uetovs', source: '~/.claude.json', state: 'unreachable', detail: '5 秒内没答出工具表', tools: [] },
  ],
  claims: externalClaims(),
  ...over,
})

test('代理的服务里被 find 接管的查找工具不给，其余照给；代理不了的退回直接挂并写明原因', () => {
  const plan = exposurePlan(input())
  assert.equal(plan.proxy, true)
  const [idea, vs] = plan.servers
  assert.equal(idea.mode, 'proxy')
  assert.deepEqual(
    idea.tools.map((x) => [x.name, x.shown, x.hiddenBy?.use]),
    [
      ['lua_code', false, 'find'],
      ['lua_debug_session', true, undefined],
    ],
  )
  assert.deepEqual([vs.mode, vs.why, vs.detail], ['direct', 'unreachable', '5 秒内没答出工具表'])
  assert.deepEqual(shownProxied(plan), [{ server: 'idea', tool: 'lua_debug_session' }])
  // 这一轮没有 find（只有四个工具的 Chat 对话）：不接管，lua_code 照给
  const chat = exposurePlan(input({ panelTools: ['end_turn'] }))
  assert.ok(chat.servers[0].tools.every((x) => x.shown))
})

test('关了代理、CLI 做不到、没有面板服务时整轮照旧直接挂，工具一个不藏', () => {
  for (const [over, why] of [
    [{ enabled: false }, 'off'],
    [{ cliCan: false }, 'cli'],
    [{ panel: false }, 'no-panel'],
  ] as const) {
    const plan = exposurePlan(input(over))
    assert.equal(plan.proxy, false, why)
    assert.ok(plan.servers.every((s) => s.mode === 'direct' && s.why === why))
    assert.ok(plan.servers.every((s) => s.tools.every((x) => x.shown)))
  }
})

test('插件登记的查找路用到的工具也算 find 接管；和自带的重名只算一次', () => {
  const claims = externalClaims([
    { tool: 'ue_find_asset', by: 'ue' },
    { tool: 'lua_code', by: 'ue' },
  ])
  assert.deepEqual(
    claims.map((c) => [c.by, c.tools.includes('ue_find_asset')]),
    [
      ['builtin', false],
      ['ue', true],
    ],
  )
  assert.ok(!claims[1].tools.includes('lua_code'))
  const plan = exposurePlan(
    input({ claims, servers: [{ name: 'ue', source: 'library', state: 'ok', tools: ['ue_find_asset', 'ue_set'] }] }),
  )
  assert.deepEqual(
    plan.servers[0].tools.filter((x) => !x.shown).map((x) => [x.name, x.hiddenBy?.by]),
    [['ue_find_asset', 'ue']],
  )
})

test('代理的外部工具收在 more_tools 后面：外部工具再多定义也不超 3000 字；网关和界面按真正的服务和工具认', () => {
  const panel = [{ name: 'find', description: '找东西', inputSchema: {} }]
  assert.equal(splitDeferred(panel).listed.length, 1, '没有外部工具也没有收起来的面板工具时不加入口')
  const many = Array.from({ length: 80 }, (_, i) => ({ server: `svc${i % 4}`, tool: `tool_with_long_name_${i}` }))
  const { listed } = splitDeferred(panel, many)
  const more = listed.find((x) => x.name === 'more_tools')!
  assert.ok(JSON.stringify(more).length <= 3000, `more_tools 定义 ${JSON.stringify(more).length} 字`)
  assert.match(more.description!, /服务\/工具/)
  assert.match(more.description!, /name 写「svc3\/」列出/, '超出预算的服务只写个数')

  const call = proxiedCallOf({
    cli: 'claude',
    tool: 'mcp__panel__more_tools',
    kind: 'panel',
    panel: 'more_tools',
    input: { name: 'idea/lua_debug_session', arguments: { action: 'status' } },
    paths: [],
  })
  assert.deepEqual(
    [call?.kind, call?.server, call?.mcpTool, call?.proxied, call?.input],
    ['mcp', 'idea', 'lua_debug_session', true, { action: 'status' }],
  )
  assert.equal(
    proxiedCallOf({
      cli: 'claude',
      tool: 'x',
      kind: 'panel',
      panel: 'more_tools',
      input: { name: 'list_peers' },
      paths: [],
    }),
    undefined,
    '收起来的面板工具不算',
  )
  assert.deepEqual(unwrapProxied(JSON.stringify({ name: 'idea/lua_code', arguments: { a: 1 } })), {
    server: 'idea',
    tool: 'lua_code',
    args: { a: 1 },
  })
  assert.equal(unwrapProxied(JSON.stringify({ name: 'idea/lua_code' })), undefined, '只查用法不算调用')
})
