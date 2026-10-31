/**
 * Markdown 样式：设置里只存改过的项、坏值退回默认，index.css 里的默认变量和 MD_SPEC 对得上。
 * 默认值两边各写一份（CSS 要在设置取回来之前就能画），靠这里防止只改了一边。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Appearance } from './schema.ts'
import { cleanMarkdownStyle, markdownCss, markdownDefaultVars, mdValue, setMdValue } from './markdown-style.ts'

test('index.css 的 :root 默认变量和 MD_SPEC 一致', () => {
  const css = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8')
  const declared = new Map([...css.matchAll(/^\s*(--md-[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]))
  for (const [k, v] of Object.entries(markdownDefaultVars())) assert.equal(declared.get(k), v, k)
})

test('没设置过的旧数据读进来是空对象，全部用默认值', () => {
  const a = Appearance.parse({ fontSize: 15 })
  assert.deepEqual(a.markdown, {})
  assert.equal(mdValue(a.markdown, 'h2', 'size'), 1.28)
  assert.equal(markdownCss(a.markdown), '')
})

test('越界、不认识、等于默认值的项都丢掉', () => {
  const s = cleanMarkdownStyle({
    h1: { size: 9, weight: '500', color: 'rainbow' },
    table: { zebra: false, border: 'rows' },
    nope: { x: 1 },
    code: { bg: { light: '#ffffff', dark: 'red' } },
  })
  assert.deepEqual(s, { h1: { weight: '500' }, table: { zebra: false } })
})

test('改回默认值时删掉这一项，整组没改过时删掉元素', () => {
  let s = setMdValue({}, 'quote', 'italic', true)
  assert.deepEqual(s, { quote: { italic: true } })
  s = setMdValue(s, 'quote', 'italic', false)
  assert.deepEqual(s, {})
})

test('自定义颜色浅色写在 :root、深色写在 :root.dark', () => {
  const css = markdownCss({ link: { color: { light: '#112233', dark: '#ddeeff' } }, table: { border: 'grid' } })
  assert.match(css, /^:root\{[^}]*--md-link-color:#112233/)
  assert.match(css, /--md-table-border-row:1px;--md-table-border-col:1px/)
  assert.match(css, /:root\.dark\{--md-link-color:#ddeeff\}$/)
})

test('标题装饰、渐隐分隔线一项落成几个变量', () => {
  const css = markdownCss({ h5: { deco: 'dot' }, hr: { style: 'dashed' } })
  assert.match(css, /--md-h5-deco-display:inline-block;--md-h5-deco-w:0\.45em;--md-h5-deco-h:0\.45em/)
  assert.match(css, /--md-hr-style:dashed;--md-hr-style-fade:none/)
})
