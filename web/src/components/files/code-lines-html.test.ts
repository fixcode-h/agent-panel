/**
 * 文件弹窗阅读区一块的 HTML：落单的 \r 不能留在里面（innerHTML 会把它当成换行，行被撑高，后面整块错位叠字）。
 * 拼 HTML 以前写在 CodeLines 组件里，没有单测；界面检查的演示文件都是 \n 或 \r\n 换行，碰不到这种情况。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockHtml } from './code-lines-html'

test('\\r\\r\\n 混合换行：拆完残留的 \\r 不进 HTML，行号照旧', () => {
  const lines = 'a\r\r\nUE_LOG(TEXT("x"));\r\nb\rc'.split('\n')
  const html = blockHtml(lines, null, 0, 2, undefined)
  assert.equal(html.includes('\r'), false)
  assert.equal((html.match(/data-line=/g) ?? []).length, 3)
  assert.match(html, /data-line="2" data-on/)
  assert.match(html, />bc</)
})

test('高亮结果和搜索命中里的 \\r 也去掉', () => {
  const html = blockHtml(
    ['x\r'],
    ['<span class="hljs-keyword">x</span>\r'],
    0,
    undefined,
    new Map([[0, [{ from: 0, to: 1, current: true }]]]),
  )
  assert.equal(html.includes('\r'), false)
})
