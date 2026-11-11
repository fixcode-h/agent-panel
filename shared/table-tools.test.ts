/** 批量编辑：自动编号、向下填充（复制 / 递增）、查找替换（整格、大小写、正则） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fillDown, findReplace, nextKey } from './table-tools.ts'

test('自动编号：主键最大的整数 + 1，跳过表头和不是数字的', () => {
  assert.equal(nextKey([['ID'], ['1001'], ['x'], ['1005'], ['']], 1, 0), '1006')
  assert.equal(nextKey([['ID'], ['a']], 1, 0), '')
  assert.equal(nextKey([['ID'], ['9007199254740993']], 1, 0), '9007199254740994')
})

test('向下填充：默认复制第一行；序列按前两行的差递增，只有一行数字时每行 +1', () => {
  const g = [
    ['10', 'a'],
    ['20', ''],
    ['', ''],
    ['', ''],
  ]
  assert.deepEqual(
    fillDown(g, [0, 1, 2, 3], [1]).map((x) => x.v),
    ['a', 'a', 'a'],
  )
  assert.deepEqual(
    fillDown(g, [0, 1, 2, 3], [0], true).map((x) => [x.r, x.v]),
    [
      [2, '30'],
      [3, '40'],
    ],
  )
  assert.deepEqual(
    fillDown([['5'], [''], ['']], [0, 1, 2], [0], true).map((x) => x.v),
    ['6', '7'],
  )
})

test('查找替换：限定行列、整格、大小写、正则', () => {
  const g = [
    ['Sword', 'sword'],
    ['Big Sword', 'x'],
  ]
  assert.deepEqual(
    findReplace(g, [0, 1], [0, 1], 'sword', 'Axe').cells.map((x) => `${x.r}${x.c}:${x.v}`),
    ['00:Axe', '01:Axe', '10:Big Axe'],
  )
  assert.equal(findReplace(g, [0, 1], [0], 'sword', 'Axe', { caseSensitive: true }).cells.length, 0)
  assert.equal(findReplace(g, [0, 1], [0], 'Sword', 'Axe', { whole: true }).cells.length, 1)
  assert.deepEqual(
    findReplace(g, [1], [0], '(\\w+) Sword', '$1 Axe', { regex: true }).cells.map((x) => x.v),
    ['Big Axe'],
  )
  // 替换文字里的 $ 不按正则时原样写进去
  assert.equal(findReplace(g, [0], [0], 'Sword', '$1').cells[0].v, '$1')
})
