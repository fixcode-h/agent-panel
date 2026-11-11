/**
 * 表头识别：游戏配置表（修饰 / 导出端 / 类型 / 字段名 / 注释）、普通 CSV、带标题行的表、没有表头的表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dataStart,
  detectSheetHeader,
  headerFit,
  pickHeader,
  rowRole,
  titleRowOf,
  validHeader,
  type SheetRole,
} from './sheet-header.ts'

const GAME = [
  ['optional', 'optional', 'optional', 'optional', 'optional', 'repeated', 'repeated', 'optional'],
  ['Client', 'Client', 'Client', 'Client', 'Editor', 'Client', 'Client', 'Client'],
  ['uint32', 'uint32', 'HomeDecorationSizeType', 'HomeDecorationMountType', 'bytes', 'uint32', 'uint32', 'int32'],
  ['ID', 'EntryID', 'SizeType', 'MountType', 'DisplayName', 'AllowIDs', 'ForbiddenIDs', 'TriggerState'],
  [
    '全局唯一软装配置ID',
    '交互物Entry ID',
    '家具尺寸',
    '家装挂载类型',
    '软装显示名',
    '交互白名单',
    '交互黑名单',
    '触发交互状态',
  ],
  ['1', '781713001', 'S', 'FloorMirror', '曲线穿衣镜', '', '', '-1'],
  ['2', '781713002', 'S', 'FloorMirror', '高脚穿衣镜', '', '', '-1'],
  ['3', '781713003', 'XS', 'TabletopDecor', '桌上圆镜', '1001;1003', '', '-1'],
]

test('游戏配置表：五行表头按顺序认出来', () => {
  const h = detectSheetHeader(GAME)
  assert.deepEqual(h, { start: 0, roles: ['modifier', 'side', 'type', 'name', 'comment'], sure: true })
  assert.equal(dataStart(h), 5)
  assert.equal(titleRowOf(h), 3)
})

test('没有导出端行、类型全是自定义类型名也认得出', () => {
  const rows = [
    ['ItemId', 'ItemKind', 'Quality'],
    ['ID', 'Kind', 'Quality'],
    ['道具ID', '种类', '品质'],
    ['10001', 'Weapon', '3'],
    ['10002', 'Armor', '2'],
  ]
  assert.deepEqual(detectSheetHeader(rows).roles, ['type', 'name', 'comment'])
})

test('普通 CSV：一行英文列名', () => {
  const rows = [
    ['id', 'name', 'price'],
    ['1', 'apple', '3.5'],
    ['2', 'pear', '4'],
  ]
  assert.deepEqual(detectSheetHeader(rows), { start: 0, roles: ['name'], sure: true })
})

test('小写列名下面全是标识符的数据：表头只算一行', () => {
  const rows = [
    ['key', 'value'],
    ['foo', 'bar'],
    ['baz', 'qux'],
    ['one', 'two'],
  ]
  assert.deepEqual(detectSheetHeader(rows).roles, ['name'])
})

test('中文列标题当字段名行', () => {
  const rows = [
    ['编号', '名称', '价格'],
    ['1', '苹果', '3.5'],
    ['2', '梨', '4'],
  ]
  assert.deepEqual(detectSheetHeader(rows).roles, ['name'])
})

test('第一行是标题：跳过它，表头从第二行开始', () => {
  const rows = [['家装配置表'], ...GAME]
  const h = detectSheetHeader(rows)
  assert.equal(h.start, 1)
  assert.equal(h.roles.length, 5)
  assert.equal(dataStart(h), 6)
})

test('全是数字：没有表头', () => {
  const rows = [
    ['1', '2', '3'],
    ['4', '5', '6'],
  ]
  assert.deepEqual(detectSheetHeader(rows), { start: 0, roles: [], sure: false })
  assert.equal(dataStart(detectSheetHeader(rows)), 0)
})

test('数据行不会被当成表头行', () => {
  assert.equal(rowRole(GAME[5]), undefined)
  assert.equal(rowRole(['1', 's', 'c']), undefined)
  assert.equal(rowRole(['Client|Server', 'Client', 'Server']), 'side')
  assert.equal(rowRole(['list<int>', 'string', 'MyEnum']), 'type')
})

test('手动设置的表头要在范围内', () => {
  assert.ok(validHeader({ start: 0, roles: ['name'] }, 10))
  assert.ok(!validHeader({ start: 10, roles: ['name'] }, 10))
  assert.ok(!validHeader({ start: 0, roles: ['what'] }, 10))
  assert.ok(!validHeader(null, 10))
})

test('多套表头按内容挑最合的：5 行表头的表挑 5 行那套，3 行的挑 3 行那套', () => {
  const five = { start: 0, roles: ['modifier', 'side', 'type', 'name', 'comment'] as SheetRole[] }
  const three = { start: 0, roles: ['type', 'name', 'comment'] as SheetRole[] }
  const enumRows = [
    ['string', 'uint32', 'string'],
    ['Name', 'Value', 'Desc'],
    ['名字', '值', '说明'],
    ['XS', '0', '特小'],
  ]
  assert.equal(pickHeader([five, three], GAME), five)
  assert.equal(pickHeader([five, three], enumRows), three)
  assert.equal(pickHeader([three, five], GAME), five)
  // 一样合时取前面的；只有一套就直接用
  assert.equal(pickHeader([three], GAME), three)
  assert.ok(headerFit(five, GAME) > headerFit(three, GAME))
})
