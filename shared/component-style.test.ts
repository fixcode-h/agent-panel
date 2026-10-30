/**
 * 组件微调：设置里只存改过的项、坏值退回默认，index.css 里的默认变量和 COMP_SPEC 对得上。
 * 默认值两边各写一份（CSS 要在设置取回来之前就能画），靠这里防止只改了一边。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Appearance } from './schema.ts'
import { cleanComponentStyle, compValue, componentCss, componentDefaultVars, setCompValue } from './component-style.ts'

test('index.css 的 :root 默认变量和 COMP_SPEC 一致', () => {
  const css = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8')
  const declared = new Map([...css.matchAll(/^\s*(--c-[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]))
  for (const [k, v] of Object.entries(componentDefaultVars())) assert.equal(declared.get(k), v, k)
})

test('只存改过的合法项：旧数据全默认、坏值丢掉、改回默认就删，自定义颜色分浅深色写', () => {
  const a = Appearance.parse({ fontSize: 15 })
  assert.deepEqual(a.components, {})
  assert.equal(compValue(a.components, 'summary', 'radius'), 0, '总结卡默认不要圆角')
  assert.equal(componentCss(a.components), '')
  const s = cleanComponentStyle({
    button: { radius: 99, weight: '600' },
    card: { shadow: true, border: true, bg: 'rainbow' },
    nope: { x: 1 },
    modal: { bg: { light: '#ffffff', dark: 'red' } },
  })
  assert.deepEqual(s, { button: { weight: '600' }, card: { border: true } })
  assert.deepEqual(setCompValue(setCompValue({}, 'summary', 'radius', 8), 'summary', 'radius', 0), {})
  const css = componentCss({
    card: { bg: { light: '#112233', dark: '#ddeeff' }, shadow: false },
    empty: { border: 'solid' },
  })
  assert.match(css, /^:root\{--c-card-bg:#112233;--c-card-shadow:none;--c-empty-border:solid\}/)
  assert.match(css, /:root\.dark\{--c-card-bg:#ddeeff\}$/)
})
