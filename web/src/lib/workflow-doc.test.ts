/**
 * 渲染结果缓存：同样的输入不重复解析、流式那段不占缓存、key 带上影响输出的输入、超过上限按 LRU 淘汰。
 * 缓存是模块级的，每个用例先清干净。末尾几条是代码块按行切开（行号）和提示块。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearDocCache, docCacheSize, lineSpans, renderDoc } from '@/lib/workflow-doc'

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

test('代码块按行切开：跨行的高亮 span 在行尾关上、下一行重新打开', () => {
  const { html, count } = lineSpans('<span class="c">/* a\nb */</span>\nx\n')
  assert.equal(count, 3)
  assert.equal(
    html,
    '<span class="md-ln"><span class="c">/* a</span></span>\n<span class="md-ln"><span class="c">b */</span></span>\n<span class="md-ln">x</span>',
  )
})

test('diff 代码块：加的行、删的行分别标上', () => {
  const { html } = lineSpans('@@ -1 +1 @@\n-old\n+new\n same', true)
  assert.match(html, /<span class="md-ln md-del">-old<\/span>/)
  assert.match(html, /<span class="md-ln md-add">\+new<\/span>/)
  assert.match(html, /<span class="md-ln"> same<\/span>/)
})

test('> [!WARNING] 画成提示块，普通引用不变', () => {
  const html = renderDoc('> [!WARNING]\n> 小心\n\n> 普通引用', new Set())
  assert.match(html, /<div class="md-alert" data-kind="warning"><p class="md-alert-title">[^<]+<\/p><p>小心<\/p>/)
  assert.match(html, /<blockquote>\n<p>普通引用<\/p>/)
})

test('图片只放行外链和内联的位图 / SVG，替代文字放到图注里', () => {
  const html = renderDoc('![图注](data:image/png;base64,AAAA) ![坏](data:text/html,x)', new Set())
  assert.match(
    html,
    /<span class="md-fig"><img src="data:image\/png;base64,AAAA" alt="图注"><span class="md-cap">图注<\/span><\/span>/,
  )
  assert.doesNotMatch(html, /data:text\/html/)
})

test('链接：协议里夹着制表符、换行的 javascript: 不能被当成相对链接放行', () => {
  for (const href of ['java\tscript:alert(1)', 'java\nscript:alert(1)', ' javascript:alert(1)', 'JaVa\u0000Script:x'])
    assert.doesNotMatch(renderDoc(`[a](<${href}>)`, NONE), /<a /, href)
  assert.match(renderDoc('[a](https://example.com)', NONE), /<a href="https:\/\/example\.com"/)
})
