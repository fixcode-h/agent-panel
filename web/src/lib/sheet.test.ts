/** 文件弹窗的表格视图：拆 CSV、列名、列宽、按格子搜索 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { colName, colWidths, findCells, parseCsv, sniffDelimiter } from '@/lib/sheet'

test('parseCsv：引号里的分隔符、换行和两个引号；CRLF；结尾空行不要', () => {
  assert.deepEqual(parseCsv('id,name,note\r\n1,"铁剑, 新手","他说 ""好""\n第二行"\r\n2,药水,\r\n\r\n'), [
    ['id', 'name', 'note'],
    ['1', '铁剑, 新手', '他说 "好"\n第二行'],
    ['2', '药水', ''],
  ])
  // BOM 不算进第一格；最后一行没有换行；引号没闭合时剩下的都算这一格
  assert.deepEqual(parseCsv('﻿a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ])
  assert.deepEqual(parseCsv('a,"b\nc'), [['a', 'b\nc']])
  assert.deepEqual(parseCsv(''), [])
})

test('分隔符：制表符、分号能认出来，引号里的不算', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1,2\t3'), '\t')
  assert.equal(sniffDelimiter('a;b;c\n'), ';')
  assert.equal(sniffDelimiter('"a;b;c;d",e,f\n'), ',')
  assert.deepEqual(parseCsv('a;b\n1;2'), [
    ['a', 'b'],
    ['1', '2'],
  ])
  assert.deepEqual(parseCsv('a,b\tc', '\t'), [['a,b', 'c']])
})

test('列名和列宽', () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  const w = colWidths([['id', '一个很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的说明'], ['1']])
  assert.equal(w.length, 2)
  assert.ok(w[0] < w[1], '内容长的列更宽')
  assert.ok(w[1] <= 320, '列宽有上限')
})

test('findCells：一格算一处，默认不分大小写', () => {
  const rows = [
    ['ID', 'Name'],
    ['1', 'foo foo'],
    ['2', 'Foo'],
  ]
  assert.deepEqual(findCells(rows, 'foo', false), [
    { row: 1, col: 1 },
    { row: 2, col: 1 },
  ])
  assert.deepEqual(findCells(rows, 'Foo', true), [{ row: 2, col: 1 }])
  assert.deepEqual(findCells(rows, '', false), [])
})

test('十万行的 CSV 一遍拆完，不卡', () => {
  const line = '1001,"名字, 带逗号",12.5,描述描述描述\n'
  const text = line.repeat(100_000)
  const t0 = Date.now()
  const rows = parseCsv(text)
  assert.equal(rows.length, 100_000)
  assert.ok(Date.now() - t0 < 3000)
})
