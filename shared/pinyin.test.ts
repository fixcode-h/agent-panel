import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinyinInitials } from './pinyin.ts'

test('汉字换成拼音首字母，别的字符原样', () => {
  assert.equal(pinyinInitials('角色表'), 'jsb')
  assert.equal(pinyinInitials('C_装备配置.xlsx'), 'c_zbpz.xlsx')
  assert.equal(pinyinInitials('Item'), 'item')
})
