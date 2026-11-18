/** 诊断报告「功能结构」的 structure 代码块画成页签（设计稿 2026-11-18 第 2 节）：默认页签、没内容的灰掉、架构页的三种情况 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '@shared/i18n'
import { htmlCardSlots } from '@/lib/markdown/html-cards'
import { structureHtml } from '@/lib/markdown/structure'

setLang('zh')
const mermaid = (src: string) => `<div class="md-mermaid" data-src="${src.length}"></div>`
const block = (over: object) =>
  JSON.stringify({ pick: 'stack', why: '', stack: 'a  x.ts:1\n  b  y.ts:2', diagrams: [], ...over })

test('默认打开 Agent 选的页签，写出理由；没内容的页签灰掉，架构页总能点', () => {
  const html = structureHtml(
    block({
      pick: 'sequence',
      why: '4 个参与者',
      diagrams: [
        {
          kind: 'sequence',
          title: '',
          source: 'sequenceDiagram\n participant Store as cart/store',
          nodes: [{ id: 'Store', file: 'web/src/cart/store.ts', line: 51, ok: false, why: '附近没有' }],
        },
      ],
    }),
    mermaid,
  )
  assert.match(html, /data-sv-on="sequence"/)
  assert.match(html, /data-sv-tab="sequence" aria-selected="true"/)
  assert.match(html, /data-sv-tab="class" aria-selected="false" disabled/)
  assert.doesNotMatch(html, /data-sv-tab="page"[^>]*disabled/)
  assert.match(html, /调用栈<\/span> <small>2 跳<\/small>/)
  assert.match(html, /它选的：4 个参与者/)
  assert.match(html, /data-sv-panel="sequence" data-on><div class="md-mermaid"/)
  assert.match(html, /data-sv-node="Store" data-sv-label="cart\/store"/, '别名：点图上的 cart/store 对回 Store')
  assert.match(html, /位置没对上代码/)
})

test('选的页签没内容时退到有内容的那一页；JSON 坏了按原文显示', () => {
  assert.match(structureHtml(block({ pick: 'class' }), mermaid), /data-sv-on="stack"/)
  assert.match(structureHtml('{坏了', mermaid), /<pre><code>\{坏了<\/code><\/pre>/)
})

test('架构页：画好了换成 HTML 卡片；没画时给 Archify 的说明和安装入口', () => {
  const done = structureHtml(block({ pick: 'page', page: { file: 'docs/arch.html', title: '' } }), mermaid)
  assert.match(htmlCardSlots(done), /data-html-card-slot data-variant="large" data-path="docs\/arch.html"/)
  const empty = structureHtml(block({}), mermaid)
  assert.match(empty, /data-archify="off"/)
  assert.match(empty, /data-sv-act="archify"/)
  assert.match(empty, /data-sv-act="plugins"/)
  assert.match(empty, /data-sv-tab="stack">.*先看调用栈/)
})
