/** 回复里的 HTML 文件换成卡片占位：单独一段的整段换掉，句子里的接在后面；第一个大卡片，其余小卡片 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkPaths } from '@/lib/file-path'
import { htmlCardSlots } from '@/lib/markdown/html-cards'

const slots = (html: string) =>
  [...html.matchAll(/data-variant="(\w+)" data-path="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`)

test('单独一段只有 HTML 文件：整段换成大卡片', () => {
  const out = htmlCardSlots(linkPaths('<p><code>out/rag-pipeline.html</code></p>'))
  assert.deepEqual(slots(out), ['large:out/rag-pipeline.html'])
  assert.ok(!out.includes('<p>'))
})

test('句子里提到：句子保留，卡片接在后面；第二个和重复提到的用小卡片', () => {
  const html = linkPaths(
    '<p>画好了 <code>out/a.html</code>，顺手还有 <code>out/b.svg</code>：</p><p>再看一眼 <code>out/a.html</code></p>',
  )
  const out = htmlCardSlots(html)
  assert.deepEqual(slots(out), ['large:out/a.html', 'small:out/b.svg', 'small:out/a.html'])
  assert.ok(out.includes('画好了'))
})

test('别的文件、代码块、列表里的不换', () => {
  const html = linkPaths(
    '<p><code>src/a.ts</code></p><pre><code>out/a.html</code></pre><ul><li><code>out/c.html</code></li></ul>',
  )
  assert.equal(htmlCardSlots(html), html)
})

test('一段里还有别的文件标记：不整段替换', () => {
  const out = htmlCardSlots(linkPaths('<p><code>out/a.html</code> <code>src/a.ts</code></p>'))
  assert.ok(out.includes('<p>'))
  assert.deepEqual(slots(out), ['large:out/a.html'])
})
