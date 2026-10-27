/**
 * 字体设置生成的 CSS 变量，以及思源黑体什么时候才加载它的 202 个分片。
 * 默认的中文字体是系统字体，这一步不能把 fonts-cjk.css 带上首屏。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Appearance } from '@shared/schema'
import { appearanceVars, needsCjkFont } from '@/lib/appearance'

test('默认（系统字体）的字体列表里不带思源黑体', () => {
  const sans = appearanceVars(Appearance.parse({}))['--app-sans']
  assert.ok(!sans.includes("'Noto Sans SC'"), `系统字体不该列思源黑体：${sans}`)
  // 中文仍要落到系统字体上，不是留给 sans-serif 兜底
  assert.ok(sans.includes("'PingFang SC'"))
  assert.ok(sans.includes("'Microsoft YaHei'"))
})

test('选了思源黑体才排进中文字体', () => {
  const sans = appearanceVars(Appearance.parse({ cjkFont: 'noto' }))['--app-sans']
  assert.ok(sans.includes("'Noto Sans SC'"))
})

test('只有选了思源黑体才需要加载它的分片', () => {
  // 加载本身是 import() 副作用（异步），这里测的是唯一的判定出口
  assert.equal(needsCjkFont('system'), false)
  assert.equal(needsCjkFont('noto'), true)
})
