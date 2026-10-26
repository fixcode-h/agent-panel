/** 复制结果的提示文案：三种 fail 写法和 done 各对应什么，界面上的说法全由调用方传入 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyNotice } from '@/lib/copy-text'

test('copyNotice：成功只认 done，不传就不弹', () => {
  assert.equal(copyNotice('done', {}), undefined)
  assert.equal(copyNotice('done', { done: '已复制' }), '已复制')
  // 失败配置不影响成功提示
  assert.equal(copyNotice('done', { fail: '复制失败' }), undefined)
})

test('copyNotice：失败提示支持字符串、带原因的函数和静默三种写法', () => {
  assert.equal(copyNotice('fail', {}), undefined)
  assert.equal(copyNotice('fail', { fail: false }), undefined)
  assert.equal(copyNotice('fail', { fail: '复制失败' }), '复制失败')
  assert.equal(copyNotice('fail', { fail: (e) => `复制失败：${e}` }, '拒绝访问'), '复制失败：拒绝访问')
  // 没有底层原因时函数也能拼出一句完整的话
  assert.equal(copyNotice('fail', { fail: (e) => `复制失败${e ? `：${e}` : ''}` }), '复制失败')
})
