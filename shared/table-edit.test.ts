/** 表格改动的纯函数：行操作、写格子、比较、算改了哪些格子、剪贴板 TSV 的读写、格子名 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRowOps, cellRef, changedCells, gridDiff, parseClip, setCells, toClip, trimGrid } from './table-edit.ts'

const T = [
  ['ID', 'Name'],
  ['1', 'a'],
  ['2', 'b'],
]

test('行操作：插入空行、删除、按顺序做；不改原表', () => {
  assert.deepEqual(applyRowOps(T, [{ at: 1, n: 1 }]), [['ID', 'Name'], [], ['1', 'a'], ['2', 'b']])
  assert.deepEqual(
    applyRowOps(T, [
      { at: 1, n: -1 },
      { at: 2, n: 2 },
    ]),
    [['ID', 'Name'], ['2', 'b'], [], []],
  )
  assert.deepEqual(applyRowOps(T, [{ at: 5, n: 1 }]).length, 6)
  assert.equal(T.length, 3)
})

test('写格子会补行补列；比较时不管末尾的空格子和空行', () => {
  const g = setCells(applyRowOps(T, []), [{ r: 4, c: 2, v: 'x' }])
  assert.deepEqual(g[4], ['', '', 'x'])
  assert.equal(gridDiff([['a', ''], []], [['a']]), null)
  assert.deepEqual(gridDiff([['a', 'b']], [['a', 'c']]), { r: 0, c: 1, a: 'b', b: 'c' })
  assert.deepEqual(trimGrid([['a', ''], ['', ''], []]), [['a']])
})

test('改了哪些格子：按做完行操作后的位置比；改了又改回去的不算', () => {
  const now = [
    ['ID', 'Name'],
    ['9', ''],
    ['1', 'a'],
    ['2', 'B'],
  ]
  assert.deepEqual(changedCells(T, [{ at: 1, n: 1 }], now), [
    { r: 1, c: 0, v: '9' },
    { r: 3, c: 1, v: 'B' },
  ])
  assert.deepEqual(changedCells(T, [], T), [])
})

test('剪贴板：Excel 复制出来的 TSV（带引号的多行格子、末尾换行）读写一致', () => {
  const block = [
    ['a', 'b\nc'],
    ['say "hi"', ''],
  ]
  assert.deepEqual(parseClip(`${toClip(block)}\r\n`), block)
  assert.deepEqual(parseClip('x\ty\r\n1\t2\r\n'), [
    ['x', 'y'],
    ['1', '2'],
  ])
  assert.deepEqual(parseClip(''), [])
})

test('格子名：列号转字母', () => {
  assert.equal(cellRef(0, 0), 'A1')
  assert.equal(cellRef(9, 25), 'Z10')
  assert.equal(cellRef(0, 26), 'AA1')
  assert.equal(cellRef(0, 701), 'ZZ1')
  assert.equal(cellRef(0, 702), 'AAA1')
})
