import assert from 'node:assert/strict'
import test from 'node:test'
import { webExport, webReactExport } from './web.ts'
import type { Component, Widget } from './umg.ts'

const w = (Type: string, Name: string, extra: Partial<Widget> = {}): Widget => ({
  id: Name,
  Type: Type as Widget['Type'],
  Name,
  Properties: {},
  ...extra,
})

// 一个卡片子控件用在两处：A 绝对定位贴在左上角，B 在正常的排版流里
const card: Component = {
  Name: 'Card',
  DesignSize: { X: 200, Y: 100 },
  Root: w('Frame', 'Root', { Properties: { Width: 200, Height: 100 } }),
}
const root = w('Frame', 'Page', {
  Properties: { Direction: 'row', Width: 'fill', Height: 'fill' },
  Children: [
    w('UserWidget', 'A', { Class: 'Card', Slot: { Position: 'absolute', Pin: 'top-left', X: 10, Y: 10 } }),
    w('UserWidget', 'B', { Class: 'Card', Slot: {} }),
  ],
})
const d = { title: 'Page', designSize: { X: 800, Y: 600 }, root, components: [card], file: () => undefined }

test('网页导出：同一个子控件用在两处、插槽不同时各自一个类名，不再共用第一处的定位', () => {
  const html = webExport(d)
  const classes = [...html.matchAll(/<div class="(Card__Root[^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(classes, ['Card__Root', 'Card__Root--2'])
  const rule = (cls: string) => html.match(new RegExp(`\\.${cls.replace(/-/g, '\\-')} \\{([^}]*)\\}`))?.[1] ?? ''
  assert.match(rule('Card__Root'), /position: absolute/)
  assert.doesNotMatch(rule('Card__Root--2'), /position: absolute/)
})

test('React 导出：插槽和组件默认不同的那一处用 className 传进去，组件根控件按传进来的类名画', () => {
  const src = webReactExport(d)
  assert.match(src, /export function Card\(\{ className = "[^"]*absolute[^"]*" \} = \{\}\)/)
  const uses = [...src.matchAll(/<Card( className="[^"]*")? \/>/g)].map((m) => m[1] ?? '')
  assert.equal(uses.length, 2)
  assert.equal(uses[0], '', '第一处和默认一样，不用传')
  assert.ok(uses[1] && !uses[1].includes('absolute'), '第二处传自己的类名，不是绝对定位')
  assert.match(src, /className=\{className\}/)
})
