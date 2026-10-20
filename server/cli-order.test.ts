/**
 * CLI 的显示顺序：启用的在前，同一组里按拖动过的顺序，没拖过的按名字。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../shared/i18n.ts'
import { orderClis } from '../shared/settings.ts'

setLang('zh')

const list = [
  { id: 'a', name: 'Beta' },
  { id: 'b', name: 'Alpha' },
  { id: 'c', name: 'Gamma' },
]
const ids = (clis: { id: string }[]) => clis.map((c) => c.id)

test('没有拖动过时按名字比较', () => {
  assert.deepEqual(ids(orderClis(list, [])), ['b', 'a', 'c'])
})

test('启用的排在停用的前面，组内按名字', () => {
  const on = new Set(['c'])
  assert.deepEqual(ids(orderClis(list, [], (c) => on.has(c.id))), ['c', 'b', 'a'])
})

test('拖动过的顺序优先，停用的不会跑到启用的前面', () => {
  const on = new Set(['a', 'b'])
  // c 被拖到了最前面，但它是停用的，仍留在最后
  assert.deepEqual(ids(orderClis(list, ['c', 'a', 'b'], (c) => on.has(c.id))), ['a', 'b', 'c'])
})

test('同一组里按拖动后的顺序', () => {
  assert.deepEqual(ids(orderClis(list, ['c', 'b'])), ['c', 'b', 'a'])
})
