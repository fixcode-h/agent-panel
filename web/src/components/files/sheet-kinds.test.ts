/**
 * 数据表格格子的显示方式：没有列结构时按类型行或数据猜数字 / 布尔列，布尔值的几种写法，枚举胶囊的颜色按值固定。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boolOf, inferColKinds, pillHue } from './sheet-kinds'

test('有类型行：按类型名认数字列、布尔列，其余不猜', () => {
  const rows = [
    ['uint32', 'float', 'bool', 'bytes', 'MountType'],
    ['ID', 'Scale', 'Visible', 'Name', 'Type'],
    ['1', '1.5', '1', 'a', 'FloorMirror'],
  ]
  const kinds = inferColKinds(rows, { start: 0, roles: ['type', 'name'] }, 2, 5)
  assert.deepEqual(
    kinds.map((k) => k?.kind),
    ['num', 'num', 'bool', undefined, undefined],
  )
})

test('没有类型行：非空格子全是数字的列算数字列，混了文字或整列空着都不算', () => {
  const rows = [
    ['ID', 'Rate', 'Name', 'Empty'],
    ['1', '12%', '1', ''],
    ['2', '-0.5', 'abc', ''],
    ['', '1e3', '3', ''],
  ]
  const kinds = inferColKinds(rows, { start: 0, roles: ['name'] }, 1, 4)
  assert.deepEqual(
    kinds.map((k) => k?.kind),
    ['num', 'num', undefined, undefined],
  )
})

test('布尔值：0 / 1 / TRUE / FALSE 认，写错的不认（照原样显示）', () => {
  assert.equal(boolOf('1'), true)
  assert.equal(boolOf(' TRUE '), true)
  assert.equal(boolOf('false'), false)
  assert.equal(boolOf('0'), false)
  assert.equal(boolOf('yes'), undefined)
  assert.equal(boolOf('2'), undefined)
})

test('枚举胶囊的色相：同一个值总是同一档，落在 0–345 的 15° 档上', () => {
  assert.equal(pillHue('FloorMirror'), pillHue('FloorMirror'))
  for (const v of ['A', 'WallMirror', '中文值', '']) {
    const h = pillHue(v)
    assert.ok(h >= 0 && h < 360 && h % 15 === 0, `${v} → ${h}`)
  }
  assert.notEqual(new Set(['FloorMirror', 'WallMirror', 'TabletopDecor', 'Lamp', 'Rug'].map(pillHue)).size, 1)
})
