/** 文件弹窗的高亮：大文件、超长行不能卡（用户 2026-11-07 报打开 167 KB 的 lua 浏览器卡死） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import hljs from 'highlight.js/lib/common'
import { LONG_LINE, highlightLines, maxCols, splitHtmlLines } from '@/lib/file-highlight'

test('高亮结果按行拆开：跨行的 span 每行补齐闭合；一整行几十万字也是线性的', () => {
  assert.deepEqual(splitHtmlLines('<span class="c">a\nb</span>\nc'), [
    '<span class="c">a</span>',
    '<span class="c">b</span>',
    'c',
  ])
  // 以前每段文字都往后找换行，一行很长时是平方级：这一行 6 万个 span 要好几秒
  const long = '<span class="k">x</span> '.repeat(60_000)
  const t = performance.now()
  const out = splitHtmlLines(`${long}\n${long}`)
  assert.equal(out.length, 2)
  assert.ok(performance.now() - t < 500, `拆两行超长的高亮结果用了 ${Math.round(performance.now() - t)}ms`)
})

test('超长的行不上色（按纯文本画），其余的行照常高亮，也不被它里面没配对的引号带偏', () => {
  const long = `x = "${'a'.repeat(LONG_LINE)}`
  const out = highlightLines(hljs, `local a = 1\n${long}\nlocal b = "s"`, 'm.lua')!
  assert.equal(out.length, 3)
  assert.match(out[0]!, /hljs-keyword/)
  assert.equal(out[1], undefined)
  assert.match(out[2]!, /hljs-string/)
  assert.equal(highlightLines(hljs, 'abc', 'x.unknownext'), null)
})

test('最长一行的宽度：中文按两格、制表符按对齐算', () => {
  assert.equal(maxCols(['ab', 'abcd'], 4), 4)
  assert.equal(maxCols(['中文ab'], 4), 6)
  assert.equal(maxCols(['\tx', 'ab\tc'], 4), 5)
})
