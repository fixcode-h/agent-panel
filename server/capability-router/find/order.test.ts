/**
 * 按类别排路（./order.ts）：其他文件不问外部服务、看不出类型的外部服务排在面板后面。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExternalFindSource, FindOutcome, FindRequest } from '../../../shared/capability-router/find/types.ts'
import type { RouteSource } from '../router.ts'
import { orderSources } from './order.ts'

const src = (id: string, rank: number): RouteSource<FindRequest, FindOutcome> => ({
  id,
  rank,
  accepts: () => false,
  ready: () => ({ state: 'ready' }),
  run: async () => ({ hits: [] }),
})
const spec = (id: string): ExternalFindSource => ({
  id,
  tool: id,
  kinds: ['refs'],
  langs: ['cpp'],
  rank: 10,
  args: () => ({}),
})
const ext = [
  { spec: spec('vs'), src: src('vs', 10) },
  { spec: spec('idea'), src: src('idea', 10) },
]
const text = src('panel.text', 1000)
const req: FindRequest = { kind: 'refs', query: 'Foo', lang: 'other', limit: 50, offset: 0 }

test('其他文件只走面板', () => {
  assert.deepEqual(
    orderSources('panel', ext, text, req).map((s) => s.id),
    ['panel.text'],
  )
})

test('C++ / Lua 先外部后面板', () => {
  assert.deepEqual(
    orderSources('specialist', ext, text, req).map((s) => s.id),
    ['vs', 'idea', 'panel.text'],
  )
})

test('看不出类型：面板排第一，外部服务排后面且都接', () => {
  const o = orderSources('panel-first', ext, text, req)
  assert.deepEqual(
    [...o].sort((a, b) => a.rank - b.rank).map((s) => s.id),
    ['panel.text', 'vs', 'idea'],
  )
  assert.ok(o.slice(1).every((s) => s.accepts(req)))
})
