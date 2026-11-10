/** 文件弹窗自己的搜索：找命中、按行分、在高亮好的 HTML 里套 <mark>；编辑器按高亮 HTML 上色 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { htmlSpans } from '@/lib/file-highlight'
import { findHits, hitsByLine, lineOf, lineStarts, markHtml } from '@/lib/file-search'

test('找命中：默认不分大小写、可以区分；按行分好，当前那一处单独标', () => {
  const text = 'Foo bar\nfoo foo\nbaz'
  assert.deepEqual(findHits(text, 'foo', false), [
    { from: 0, to: 3 },
    { from: 8, to: 11 },
    { from: 12, to: 15 },
  ])
  assert.equal(findHits(text, 'foo', true).length, 2)
  assert.deepEqual(findHits(text, '', false), [])
  const starts = lineStarts(text)
  assert.deepEqual(starts, [0, 8, 16])
  assert.equal(lineOf(starts, 12), 1)
  const byLine = hitsByLine(findHits(text, 'foo', false), starts, 1)
  assert.deepEqual(byLine.get(1), [
    { from: 0, to: 3, current: true },
    { from: 4, to: 7, current: false },
  ])
})

test('在高亮好的 HTML 里套 <mark>：跨标签时先收起再接着开，实体算一个字', () => {
  const html = '<span class="k">local</span> a &lt; b'
  // 「cal a」跨过 </span>
  assert.equal(
    markHtml(html, [{ from: 2, to: 7, current: false }]),
    '<span class="k">lo<mark class="file-hit">cal</mark></span><mark class="file-hit"> a</mark> &lt; b',
  )
  // 「&lt;」是一个字
  assert.equal(
    markHtml(html, [{ from: 8, to: 9, current: true }]),
    '<span class="k">local</span> a <mark class="file-hit file-hit-current" data-current>&lt;</mark> b',
  )
})

test('高亮 HTML 拆成上色区间：嵌套的 span 各成一段，实体算一个字', () => {
  assert.deepEqual(htmlSpans('<span class="a">x<span class="b">&amp;y</span></span>z'), [
    { from: 1, to: 3, cls: 'b' },
    { from: 0, to: 3, cls: 'a' },
  ])
})
