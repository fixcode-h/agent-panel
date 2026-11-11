/** 一列的统计和规则推断：数字范围、少数几种值建议枚举、没空的建议必填 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TableSchema } from './tables.ts'
import { columnStats, inferRules } from './table-stats.ts'
import type { ColInfo } from './table-struct.ts'

const info = (p: Partial<ColInfo>): ColInfo =>
  ({
    col: 0,
    field: 'F',
    type: '',
    head: [],
    kind: 'string',
    list: false,
    sep: ';',
    remark: false,
    custom: false,
    ...p,
  }) as ColInfo

test('统计：空值、唯一值、出现最多的值、最小最大；数组列按项算', () => {
  const rows = [['H'], ['3'], ['1'], [''], ['3'], ['2']]
  const st = columnStats(rows, 1, 0)
  assert.equal(st.rows, 5)
  assert.equal(st.empty, 1)
  assert.equal(st.unique, 3)
  assert.deepEqual(st.top[0], ['3', 2])
  assert.equal(st.min, 1)
  assert.equal(st.max, 3)
  assert.ok(st.ints)
  assert.deepEqual(columnStats([['a;b'], ['b']], 0, 0, ';').top[0], ['b', 2])
})

test('推断：整数给范围、几种字给枚举（写进结构文件）、没空的给必填；设过的不再建议', () => {
  const nums = columnStats([['0'], ['4'], ['2'], ['1'], ['3']], 0, 0)
  const hints = inferRules(nums, info({ kind: 'int' }), 'a.xlsx')
  assert.deepEqual(
    hints.map((h) => h.id),
    ['range', 'required'],
  )
  const s = hints[0].apply(TableSchema.parse({}))
  assert.deepEqual(s.columns['a.xlsx#*#F'], { min: 0, max: 4 })
  assert.deepEqual(
    inferRules(nums, info({ kind: 'int', min: 0, required: true }), 'a.xlsx').map((h) => h.id),
    [],
  )
  const words = columnStats(
    Array.from({ length: 9 }, (_, i) => [['S', 'M', 'L'][i % 3]]),
    0,
    0,
  )
  const e = inferRules(words, info({}), 'a.xlsx').find((h) => h.id === 'enum')!
  const s2 = e.apply(TableSchema.parse({}))
  assert.equal(s2.columns['a.xlsx#*#F'].enum, 'F')
  assert.deepEqual(
    s2.enums.F.values.map((v) => v.name),
    ['L', 'M', 'S'],
  )
})
