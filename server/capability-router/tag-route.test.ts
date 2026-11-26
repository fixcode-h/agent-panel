/**
 * 工具卡片上的「实际走的路」：路由结果换成 ToolUse.route（名字、MCP 还是面板自带、跳过的原因和用时），
 * 再按查询词挂到对话里那一行 find 上。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task, ToolUse } from '../../shared/schema.ts'
import { toolRouteOf, type RouteSource } from './router.ts'
import { tagRoute } from './tag-route.ts'

const src = (id: string, label?: string, via?: 'mcp' | 'panel') =>
  ({
    id,
    label,
    via,
    rank: 0,
    accepts: () => true,
    ready: () => ({ state: 'ready' }),
    run: async () => 0,
  }) as RouteSource<never, unknown>

test('路由结果换成卡片上的路：给出结果的、跳过的（为什么）、各自多久；没登记名字的显示 id、算面板', () => {
  const r = toolRouteOf(
    'find',
    [src('ue:idea.lua_code', 'idea · lua_code', 'mcp'), src('panel.text', '面板按文本找', 'panel')],
    {
      outs: [{ source: 'panel.text', out: 0 }],
      empties: [],
      steps: [
        { source: 'ue:idea.lua_code', outcome: 'skipped', why: '没有接 lua_code 所在的服务' },
        { source: 'panel.text', outcome: 'used', ms: 380 },
        { source: 'odd', outcome: 'failed', why: 'x', ms: 3 },
      ],
      ms: 406,
    },
  )
  assert.deepEqual(r.served, [{ source: 'panel.text', label: '面板按文本找', via: 'panel' }])
  assert.equal(r.steps[0].via, 'mcp')
  assert.equal(r.steps[0].why, '没有接 lua_code 所在的服务')
  assert.equal(r.steps[0].ms, undefined)
  assert.equal(r.steps[1].ms, 380)
  assert.deepEqual({ label: r.steps[2].label, via: r.steps[2].via }, { label: 'odd', via: 'panel' })
  assert.equal(r.ms, 406)
})

const row = (input: Record<string, unknown>, label = 'panel · find'): ToolUse => ({
  kind: 'other',
  name: 'MCP',
  label,
  detail: '',
  input: JSON.stringify(input, null, 2),
})
const route = { capability: 'find', served: [], steps: [] }

test('按查询词挂到最近那一行 find 上：已经挂过的、别的工具、更早的回复不动', () => {
  const a = row({ action: 'text', query: 'CartBadge' })
  const b = row({ action: 'text', query: 'CartBadge' })
  const other = row({ query: 'CartBadge' }, 'panel · knowledge_lookup')
  const task = {
    messages: [
      { role: 'agent', step: '', tools: [a] },
      { role: 'user', tools: [] },
      { role: 'agent', step: '', tools: [b, other] },
    ],
  } as unknown as Pick<Task, 'messages'>
  assert.ok(tagRoute(task, { ...route, ms: 1 }, 'CartBadge'))
  assert.equal(b.route?.ms, 1, '从后往前，先挂最近的一行')
  assert.equal(other.route, undefined)
  assert.ok(tagRoute(task, { ...route, ms: 2 }, 'CartBadge'))
  assert.equal(a.route?.ms, 2, '挂过的跳过，挂到下一行同样的调用')
  assert.equal(tagRoute(task, route, 'CartBadge'), false)
  // 查询词按 JSON 字符串比：短词不撞别的字段
  const c = row({ action: 'symbol', query: 'Bag', under: ['BagPanel'] })
  assert.equal(tagRoute({ messages: [{ role: 'agent', tools: [c] }] } as never, route, 'Panel'), false)
  assert.ok(tagRoute({ messages: [{ role: 'agent', tools: [c] }] } as never, route, 'Bag'))
  // 旧名 file_index 照样认
  const old = row({ query: 'a.lua' }, 'panel · file_index')
  assert.ok(tagRoute({ messages: [{ role: 'agent', tools: [old] }] } as never, route, 'a.lua'))
})
