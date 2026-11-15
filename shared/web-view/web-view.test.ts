/** 网页页签的纯函数：能不能嵌（响应头）、地址栏补全、阅读模式取正文 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { embedVerdict, webUrlOf } from './embed.ts'
import { htmlToMarkdown, pageTitle } from './reader.ts'

const bag = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null })

test('X-Frame-Options 和 frame-ancestors 拒绝嵌入，写了 * 才放行', () => {
  assert.equal(embedVerdict(bag({})).embeddable, true)
  assert.equal(embedVerdict(bag({ 'x-frame-options': 'sameorigin' })).embeddable, false)
  assert.equal(
    embedVerdict(bag({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" })).embeddable,
    false,
  )
  assert.equal(embedVerdict(bag({ 'content-security-policy': 'frame-ancestors *' })).embeddable, true)
  // 没写 frame-ancestors 的 CSP 不管嵌入
  assert.equal(embedVerdict(bag({ 'content-security-policy': "script-src 'self'" })).embeddable, true)
})

test('地址栏：补协议，本机地址补 http，伪协议一律不开', () => {
  assert.equal(webUrlOf('example.com/a')?.href, 'https://example.com/a')
  assert.equal(webUrlOf('localhost:5173')?.href, 'http://localhost:5173/')
  assert.equal(webUrlOf('http://x.dev')?.href, 'http://x.dev/')
  assert.equal(webUrlOf('javascript:alert(1)'), null)
  assert.equal(webUrlOf('file:///etc/passwd'), null)
  assert.equal(webUrlOf('  '), null)
})

test('阅读模式：取 article 正文，丢掉脚本和导航，链接补成绝对地址', () => {
  const body = 'x'.repeat(220)
  const html = `<html><head><title>标题 &amp; 副标题</title><script>evil()</script></head><body>
    <nav><a href="/home">首页</a></nav>
    <article><h1>正文标题</h1><p>第一段 <a href="/doc">文档</a>，<strong>重点</strong>。</p>
    <ul><li>一</li><li>二</li></ul><pre><code>a &lt; b</code></pre><p>${body}</p>
    <a href="javascript:x()">坏链接</a><img src="i.png" alt="图"></article><footer>版权</footer></body></html>`
  assert.equal(pageTitle(html), '标题 & 副标题')
  const md = htmlToMarkdown(html, 'https://site.dev/a/b')
  assert.match(md, /^# 正文标题/)
  assert.match(md, /\[文档\]\(https:\/\/site\.dev\/doc\)/)
  assert.match(md, /\*\*重点\*\*/)
  assert.match(md, /- 一\n- 二/)
  assert.match(md, /```\na < b\n```/)
  assert.match(md, /!\[图\]\(https:\/\/site\.dev\/a\/i\.png\)/)
  assert.doesNotMatch(md, /evil|首页|版权|javascript/)
  assert.match(md, /坏链接/)
})
