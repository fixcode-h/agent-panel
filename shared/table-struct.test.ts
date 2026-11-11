/** 结构化表格：列的种类、枚举（手写 + 枚举表）、引用、范围、repeated、主键重复，以及整本检查 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TableSchema } from './tables.ts'
import type { SheetData } from './files.ts'
import {
  checkCell,
  checkSheet,
  checkWorkbook,
  columnInfos,
  columnOptions,
  enumOptions,
  headerOf,
  parseRef,
  workbookNeeds,
  type RowProblems,
} from './table-struct.ts'

const CONFIG = 'data/Config.xlsx'
const ENUMS = 'data/enum/E.xlsx'
const ROLES = 'data/Role.xlsx'

const config: SheetData = {
  name: 'Config',
  rows: [
    ['optional', 'optional', 'optional', 'repeated', 'optional', 'optional'],
    ['Client', 'Client', 'Client', 'Client', 'Client', 'Client'],
    ['uint32', 'Size', 'Mount', 'uint32', 'int32', 'bool'],
    ['ID', 'Size', 'Mount', 'RoleIDs', 'State', 'On'],
    ['编号', '尺寸', '挂载', '角色', '状态', '开关'],
    ['1', 'S', 'Floor', '1001;1002', '0', 'TRUE'],
    ['2', 'XL', '2', '1009', '-1', 'maybe'],
    ['1', 'M', 'Roof', '', '5', ''],
    ['x', '', '', '', 'a', '0'],
  ],
}
const enums: SheetData = {
  name: 'E',
  rows: [
    ['string', 'string', 'int32'],
    ['EnumName', 'Name', 'Value'],
    ['枚举名', '名字', '值'],
    ['Size', 'S', '0'],
    ['Size', 'M', '1'],
    ['Other', 'XL', '9'],
  ],
}
const roles: SheetData = {
  name: 'Role',
  rows: [
    ['uint32', 'bytes'],
    ['ID', 'Name'],
    ['编号', '名字'],
    ['1001', '艾琳'],
    ['1002', '洛克'],
  ],
}
const schema = TableSchema.parse({
  style: { key: 'ID', listSep: ';' },
  enums: {
    Mount: {
      values: [
        { name: 'Floor', value: '1' },
        { name: 'Wall', value: '2' },
      ],
    },
    Size: {
      values: [],
      source: { file: ENUMS, match: { col: 'EnumName', value: 'Size' }, nameCol: 'Name', valueCol: 'Value' },
    },
  },
  columns: {
    [`${CONFIG}#*#RoleIDs`]: { ref: `${ROLES}#ID` },
    [`${CONFIG}#*#State`]: { min: 0, max: 1, allow: ['-1'] },
  },
})
const files: Record<string, SheetData[]> = { [ENUMS]: [enums], [ROLES]: [roles] }

test('列的种类：按类型行和结构文件，repeated 按修饰行', () => {
  const h = headerOf(schema, CONFIG, config)
  assert.deepEqual(h.roles, ['modifier', 'side', 'type', 'name', 'comment'])
  const infos = columnInfos(schema, config.rows, h, CONFIG, 'Config', 6)
  assert.deepEqual(
    infos.map((i) => i.kind),
    ['uint', 'enum', 'enum', 'uint', 'int', 'bool'],
  )
  assert.equal(infos[3].list, true)
  assert.equal(infos[3].ref, `${ROLES}#ID`)
  assert.equal(infos[3].custom, true)
  assert.equal(infos[0].custom, false)
})

test('枚举选项：结构文件里的在前，枚举表里同名的不重复；按 EnumName 筛', () => {
  const h = headerOf(schema, CONFIG, config)
  const infos = columnInfos(schema, config.rows, h, CONFIG, 'Config', 6)
  const o = columnOptions(schema, infos, (f) => files[f])
  assert.deepEqual(
    o.enumOpts.get('Size')!.map((x) => x.name),
    ['S', 'M'],
  )
  assert.deepEqual(o.refOpts.get(`${ROLES}#ID`), [
    { name: '1001', desc: '艾琳' },
    { name: '1002', desc: '洛克' },
  ])
  assert.deepEqual(
    enumOptions({ values: [{ name: 'A' }] }, [{ name: 'A', value: '1' }, { name: 'B' }]).map((x) => x.name),
    ['A', 'B'],
  )
})

test('检查：类型、枚举（名字和值都算）、引用、范围和例外值、主键重复；空格子不查', () => {
  const h = headerOf(schema, CONFIG, config)
  const infos = columnInfos(schema, config.rows, h, CONFIG, 'Config', 6)
  const { ctx } = columnOptions(schema, infos, (f) => files[f])
  const got = checkSheet(config.rows, 5, infos, 'ID', ctx).map((p) => `${p.r}:${p.c}`)
  assert.deepEqual(got, ['6:1', '6:3', '6:5', '7:2', '7:4', '7:0', '8:0', '8:4'])
  // 枚举填值（2）也算对；-1 在「也允许」里
  assert.equal(checkCell(infos[2], '2', ctx), undefined)
  assert.equal(checkCell(infos[4], '-1', ctx), undefined)
  assert.equal(checkCell(infos[4], '', ctx), undefined)
})

test('引用的表还没读到时不查引用', () => {
  const h = headerOf(schema, CONFIG, config)
  const infos = columnInfos(schema, config.rows, h, CONFIG, 'Config', 6)
  const { ctx } = columnOptions(schema, infos, () => undefined)
  assert.equal(checkCell(infos[3], '9999', ctx), undefined)
})

test('整本检查：先列出要读的别的文件，再按工作表给出数量和前几处', () => {
  assert.deepEqual(workbookNeeds(schema, CONFIG, [config]).sort(), [ENUMS, ROLES].sort())
  const r = checkWorkbook(schema, CONFIG, [config], (f) => files[f], 3)
  assert.equal(r.length, 1)
  assert.equal(r[0].count, 8)
  assert.equal(r[0].first.length, 3)
  assert.equal(r[0].first[0].field, 'Size')
  // 没有字段名行的表不查
  assert.deepEqual(
    checkWorkbook(schema, 'x.csv', [{ name: 'x', rows: [['1', '2']] }], () => undefined),
    [],
  )
})

test('引用写法', () => {
  assert.deepEqual(parseRef('a.xlsx#ID'), { file: 'a.xlsx', field: 'ID' })
  assert.deepEqual(parseRef('a.xlsx#S#ID'), { file: 'a.xlsx', sheet: 'S', field: 'ID' })
  assert.deepEqual(parseRef('a.xlsx##ID'), { file: 'a.xlsx', sheet: undefined, field: 'ID' })
  assert.equal(parseRef('a.xlsx'), null)
})

test('按行缓存检查结果：没改的行直接用上次的，改了的行重查', () => {
  const schema = TableSchema.parse({})
  const rows = [['uint32'], ['ID'], ['1'], ['x'], ['3']]
  const infos = columnInfos(schema, rows, { start: 0, roles: ['type', 'name'] }, 'a.csv', 'a', 1)
  const ctx = columnOptions(schema, infos, () => undefined).ctx
  const cache = new WeakMap<string[], RowProblems>()
  const first = checkSheet(rows, 2, infos, 'ID', ctx, 2000, cache)
  assert.deepEqual(
    first.map((p) => p.r),
    [3],
  )
  // 改第 4 行：只复制这一行（和表格页一样），其余行还是原来的数组
  const next = [...rows]
  next[3] = ['2']
  next[4] = ['2']
  const again = checkSheet(next, 2, infos, 'ID', ctx, 2000, cache)
  assert.deepEqual(
    again.map((p) => [p.r, p.msg.startsWith('主键重复')]),
    [[4, true]],
  )
  assert.ok(cache.has(rows[2]))
})
