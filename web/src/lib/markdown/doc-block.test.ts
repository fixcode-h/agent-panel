/** markdown 代码块按文档显示（「文档定稿」里 Agent 把整份文档包进 ```markdown，2026-11-24） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderDoc } from '@/lib/workflow-doc'
import { widenDocFences } from '@/lib/markdown/doc-block'

const DOC = [
  '### design.md',
  '```markdown',
  '# 设计',
  '',
  '| 术语 | 含义 |',
  '| --- | --- |',
  '| 酒量 | 血量 |',
  '',
  '```mermaid',
  'classDiagram',
  '  class A',
  '```',
  '',
  '结尾一段',
  '```',
  '',
  '外面的话',
].join('\n')

test('包着 mermaid 的 ```markdown：外层围栏加长，里面的 ``` 不再提前关掉它', () => {
  const out = widenDocFences(DOC).split('\n')
  assert.equal(out[1], '````markdown')
  assert.equal(out[11], '```')
  assert.equal(out[14], '````')
  // 没有 markdown 块的原样返回
  assert.equal(widenDocFences('```ts\nx\n```'), '```ts\nx\n```')
})

test('markdown 代码块默认渲染成文档：表格、mermaid 照常画，原文留着切「源码」和复制', () => {
  const html = renderDoc(DOC, new Set())
  assert.match(html, /class="md-code md-docblock" data-view="doc"/)
  assert.match(html, /md-docblock-body"><h1[^>]*>设计<\/h1>/)
  assert.match(html, /<table/)
  assert.match(html, /class="md-mermaid"/)
  assert.match(html, /<p>结尾一段<\/p>[\s\S]*<\/div><pre>/, '结尾一段还在文档块里，后面是收起的源码')
  assert.match(html, /<p>外面的话<\/p>/)
  assert.match(html, /data-src="# 设计/)
})
