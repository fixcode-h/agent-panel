import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INTENT_HINT, intentOf, withIntent } from './intent.ts'

test('标了 intent 的工具参数表补上 intent，没标的不动', () => {
  const schema = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }
  assert.equal(withIntent(schema, false), schema)
  const out = withIntent(schema, true) as { properties: Record<string, { description?: string }>; required: string[] }
  assert.equal(out.properties.intent.description, INTENT_HINT)
  assert.ok(out.properties.code)
  assert.deepEqual(out.required, ['code'])
  // 插件自己写了同名参数的不覆盖
  const own = { type: 'object', properties: { intent: { type: 'string', description: '自己的' } } }
  assert.equal(withIntent(own, true), own)
})

test('意图取第一行非空文字', () => {
  assert.equal(intentOf({ intent: '\n  打印玩家血量 \n第二行' }), '打印玩家血量')
  assert.equal(intentOf({ intent: 3 }), '')
  assert.equal(intentOf({}), '')
})
