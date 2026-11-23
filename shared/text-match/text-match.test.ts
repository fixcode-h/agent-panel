import assert from 'node:assert/strict'
import test from 'node:test'
import { globMatch, textHit, textScore, wildcard } from './index.ts'

test('通配：* 任意、? 一个字，不分大小写，被比的在前', () => {
  assert.ok(wildcard('BP_Goblin_Boss', '*_boss'))
  assert.ok(wildcard('BP_A1', 'bp_a?'))
  assert.ok(!wildcard('BP_A12', 'BP_A?'))
  assert.ok(!wildcard('BPxBoss', 'BP.Boss'))
  assert.ok(wildcard('任何', ''))
})

test('glob：** 跨目录且能匹配零层，* 不跨 /，{a,b}，dirPrefix 时不带通配的按目录前缀', () => {
  assert.ok(globMatch('**/*.cpp', 'a.cpp'))
  assert.ok(globMatch('src/**/*.ts', 'src/a/b/c.ts'))
  assert.ok(!globMatch('src/*.ts', 'src/a/c.ts'))
  assert.ok(globMatch('Source/**/*.{h,cpp}', 'Source/X/A.h'))
  assert.ok(globMatch('web/src', 'web/src/App.tsx', { dirPrefix: true }))
  assert.ok(!globMatch('web/src', 'web/src/App.tsx'))
  assert.ok(globMatch('Config/*.XLSX', 'config/a.xlsx', { ignoreCase: true }))
  assert.ok(globMatch('./web\\', 'web/x', { dirPrefix: true }))
})

test('列表搜索：多词都要命中、认拼音首字母；打分整句 > 开头 > 词首 > 包含 > 首字母', () => {
  assert.ok(textHit(['Config/角色表.xlsx'], 'jsb'))
  assert.ok(textHit(['Config/Item.csv', 'Item'], 'config item'))
  assert.ok(!textHit('Config/Item.csv', 'config hero'))
  const order = ['shop', 'ShopNpc', 'BP_Shop', 'workshop', '商店'].map((x) => textScore(x, 'shop'))
  assert.deepEqual(order, [100, 80, 60, 40, 0])
  assert.equal(textScore('商店', 'sd'), 20)
})
