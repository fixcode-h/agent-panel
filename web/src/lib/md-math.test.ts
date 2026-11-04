/** Markdown 里的数学公式：认出来输出占位（原文 + data-tex），金额、代码里的 $ 不当成公式 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearDocCache, renderDoc } from '@/lib/workflow-doc'

const NONE = new Set<string>()
const html = (s: string) => {
  clearDocCache()
  return renderDoc(s, NONE, false)
}

test('行内 $…$ 和 \\(…\\) 变成行内公式占位，原文留着', () => {
  const h = html('面积是 $\\pi r^2$，周长 \\(2\\pi r\\)')
  assert.match(h, /<span class="md-math" data-tex="\\pi r\^2">\$\\pi r\^2\$<\/span>/)
  assert.match(h, /<span class="md-math" data-tex="2\\pi r">/)
})

test('独占一块的 $$…$$ 和 \\[…\\] 变成块级公式', () => {
  assert.match(html('$$\nE = mc^2\n$$'), /<div class="md-math md-math-block" data-tex="E = mc\^2">/)
  assert.match(html('\\[\n\\sum_i x_i\n\\]'), /<div class="md-math md-math-block" data-tex="\\sum_i x_i">/)
})

test('金额和代码里的 $ 不当成公式', () => {
  assert.doesNotMatch(html('苹果 $5，香蕉 $10'), /md-math/)
  assert.doesNotMatch(html('价格从 $ 5 涨到 $ 8'), /md-math/)
  assert.doesNotMatch(html('`echo $HOME $PATH`'), /md-math/)
  assert.doesNotMatch(html('```sh\necho $a$b\n```'), /md-math/)
})

test('公式里的尖括号转义，不会变成 HTML', () => {
  assert.match(html('$a<b$'), /data-tex="a&lt;b"/)
})
