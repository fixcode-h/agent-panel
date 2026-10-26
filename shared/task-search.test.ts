/**
 * 对话内容搜索的片段口径：命中几次、从哪截、前端按哪个位置高亮。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SNIPPET_MAX, SNIPPET_PAD, flatText, messageHit, type SearchHit } from './task-search.ts'

test('没有命中或搜索词为空时不算命中', () => {
  assert.equal(messageHit('今天改了回收站', ''), null)
  assert.equal(messageHit('', '回收站'), null)
  assert.equal(messageHit('今天改了回收站', '搜索'), null)
})

test('命中词在中间：两侧留一段，首尾被截断时补省略号', () => {
  const text = '前'.repeat(100) + '回收站' + '后'.repeat(100)
  const hit = messageHit(text, '回收站')
  assert.ok(hit)
  assert.equal(hit.count, 1)
  assert.ok(hit.snippet.startsWith('…') && hit.snippet.endsWith('…'), '两侧都被截断')
  assert.equal(hit.snippet.slice(hit.index, hit.index + 3), '回收站', 'index 指向片段里的命中词')
  assert.ok(hit.snippet.length <= SNIPPET_MAX + 2, '片段长度有上限（含两侧省略号）')
  assert.ok(hit.index >= SNIPPET_PAD - 1, '命中词前方留够上下文')
})

test('命中在开头时前面不补省略号', () => {
  const hit = messageHit('回收站里的对话能恢复', '回收站')
  assert.ok(hit)
  assert.equal(hit.snippet, '回收站里的对话能恢复')
  assert.equal(hit.index, 0)
})

test('换行和多余空格压成一行再算，片段不会从半句话切开', () => {
  const text = '第一行\n\n第二行里有 回收站 这个词\n第三行'
  const hit = messageHit(text, '回收站')
  assert.ok(hit)
  assert.equal(hit.snippet, flatText(text))
  assert.equal(hit.snippet.slice(hit.index, hit.index + 3), '回收站')
})

test('一条消息里出现多次：次数照实给，片段只截第一处', () => {
  const hit = messageHit('回收站 回收站 回收站', '回收站')
  assert.ok(hit)
  assert.equal(hit.count, 3)
  assert.equal(hit.index, 0)
})

test('大小写不敏感：原文什么样就显示什么样，index 按原文位置算', () => {
  const hit = messageHit('Use the SearchBox please', 'searchbox')
  assert.ok(hit)
  assert.equal(hit.snippet.slice(hit.index, hit.index + 9), 'SearchBox')
})

test('接口类型只带片段和定位，不带整条消息', () => {
  const hit = messageHit('回收站', '回收站')
  const row: SearchHit = {
    taskId: 't1',
    title: '删对话',
    messageId: 'm1',
    role: 'user',
    at: '2026-10-01T00:00:00.000Z',
    count: hit!.count,
    snippet: hit!.snippet,
    index: hit!.index,
    length: 3,
  }
  assert.equal(Object.keys(row).includes('text'), false)
  assert.equal(row.length, 3)
})
