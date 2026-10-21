import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relatedTasks } from '../shared/related.ts'
import type { Task } from '../shared/schema.ts'

const task = (id: string, title: string, summary = '', first = '') =>
  ({
    id,
    title,
    summary,
    messages: first ? [{ role: 'user', text: first }] : [],
  }) as unknown as Task

test('新要求按字面找相关的对话：同一件事排在前面，无关的和太短的不给', () => {
  const list = [
    task('a', '商品详情页增加到货通知', '按钮改成「到货通知我」，登记手机号'),
    task('b', '订单导出 Excel 时间格式', '导出的时间列改成本地时区'),
    task('c', '购物车右上角的数量角标'),
  ]
  const got = relatedTasks('到货通知的按钮在详情页上点了没反应', list)
  assert.equal(got[0]?.task.id, 'a')
  assert.ok(!got.some((x) => x.task.id === 'c'))
  assert.equal(relatedTasks('导出 excel 的时间列还是不对', list)[0]?.task.id, 'b')
  assert.deepEqual(relatedTasks('帮我看看', list), [])
  assert.deepEqual(relatedTasks('新增一个登录页面，支持扫码', list), [])
})
