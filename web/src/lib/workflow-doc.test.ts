/**
 * 渲染结果缓存：同样的输入不重复解析、流式那段不占缓存、key 带上影响输出的输入、超过上限按 LRU 淘汰。
 * 缓存是模块级的，每个用例先清干净。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearDocCache, docCacheSize, renderDoc } from '@/lib/workflow-doc'

const NONE = new Set<string>()

test('同样的输入第二次直接用缓存', () => {
  clearDocCache()
  const first = renderDoc('# 标题', NONE)
  assert.equal(docCacheSize(), 1)
  assert.equal(renderDoc('# 标题', NONE), first)
  assert.equal(docCacheSize(), 1, '命中时不再新增一条')
})

test('流式那一段不写缓存：它每 200ms 就变一次', () => {
  clearDocCache()
  renderDoc('正在输出', NONE, true)
  assert.equal(docCacheSize(), 0)
})

test('团队成员变了要重新渲染：@提及的样式跟着变', () => {
  clearDocCache()
  const alone = renderDoc('@小明 看一下', NONE)
  assert.equal(renderDoc('@小明 看一下', new Set(['小明'])), renderDoc('@小明 看一下', new Set(['小明'])))
  assert.notEqual(alone, renderDoc('@小明 看一下', new Set(['小明'])))
  assert.equal(docCacheSize(), 2)
})

test('超过上限时丢掉最久没用的一条', () => {
  clearDocCache()
  for (let i = 0; i < 300; i++) renderDoc(`第 ${i} 段`, NONE)
  assert.equal(docCacheSize(), 300)
  // 再用一次第 0 段：它变成最近用的，接着淘汰别人
  const first = renderDoc('第 0 段', NONE)
  renderDoc('新的一段', NONE)
  assert.equal(docCacheSize(), 300)
  assert.equal(renderDoc('第 0 段', NONE), first)
})
