/**
 * 字体设置生成的 CSS 变量，以及内置中文字体（思源黑体 / Maple Mono CN）什么时候才加载分片。
 * 默认是 Maple Mono NL 配思源黑体；选系统中文字体时不能把内置中文字体的 CSS 带上首屏。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Appearance } from '@shared/schema'
import { appearanceVars, needsCjkFont } from '@/lib/appearance'

test('默认字体：英文 Maple Mono NL、中文思源黑体、代码 Maple Mono NL', () => {
  const a = Appearance.parse({})
  assert.equal(a.uiFont, 'maple')
  assert.equal(a.cjkFont, 'noto')
  assert.equal(a.monoFont, 'maple')
  const vars = appearanceVars(a)
  const sans = vars['--app-sans']
  // 英文字体在前，汉字落到思源黑体
  assert.ok(sans.indexOf("'Maple Mono NL'") < sans.indexOf("'Noto Sans SC'"), sans)
  assert.ok(vars['--app-mono'].startsWith("'Maple Mono NL'"))
  // 等宽字体默认收紧字距和空格
  assert.equal(vars['--app-tracking'], '-0.02em')
  assert.equal(vars['--app-word-spacing'], '-0.2em')
})

test('选系统中文字体时字体列表里不带内置中文字体', () => {
  const sans = appearanceVars(Appearance.parse({ cjkFont: 'system' }))['--app-sans']
  assert.ok(!sans.includes("'Noto Sans SC'"), `系统字体不该列思源黑体：${sans}`)
  assert.ok(!sans.includes("'Maple Mono CN'"), `系统字体不该列 Maple Mono CN：${sans}`)
  // 中文仍要落到系统字体上，不是留给 sans-serif 兜底
  assert.ok(sans.includes("'PingFang SC'"))
  assert.ok(sans.includes("'Microsoft YaHei'"))
})

test('选了 Maple Mono CN 汉字用它，缺字落到系统中文', () => {
  const sans = appearanceVars(Appearance.parse({ cjkFont: 'maple' }))['--app-sans']
  assert.ok(sans.includes("'Maple Mono CN'"))
  assert.ok(!sans.includes("'Noto Sans SC'"))
  assert.ok(sans.indexOf("'Maple Mono CN'") < sans.indexOf("'Microsoft YaHei'"))
})

test('只有选了内置中文字体才需要加载分片', () => {
  // 加载本身是 import() 副作用（异步），这里测的是唯一的判定出口
  assert.equal(needsCjkFont('system'), false)
  assert.equal(needsCjkFont('noto'), true)
  assert.equal(needsCjkFont('maple'), true)
})
