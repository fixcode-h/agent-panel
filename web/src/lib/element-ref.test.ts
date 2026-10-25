/** 元素抓取写给 AI 的引用：位置解析、组件层级去重、拼出来的文字 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentChain, formatElementRef, parseLoc, pickStyles, type ElementInfo } from '@/lib/element-ref'

test('parseLoc：路径补上 web/src/，组件名可有可无，格式不对返回 undefined', () => {
  assert.deepEqual(parseLoc('components/chat/ChatComposer.tsx:12:SendButton'), {
    file: 'web/src/components/chat/ChatComposer.tsx',
    line: 12,
    component: 'SendButton',
  })
  assert.deepEqual(parseLoc('App.tsx:3'), { file: 'web/src/App.tsx', line: 3, component: undefined })
  assert.equal(parseLoc('workflow 图'), undefined)
  assert.equal(parseLoc(null), undefined)
})

test('componentChain：同一组件连着出现只留最里面那处，没组件名的跳过，限制层数', () => {
  const l = (component: string | undefined, line: number) => ({ file: 'web/src/a.tsx', line, component })
  const chain = componentChain([
    l('Button', 9),
    l('Button', 5),
    l(undefined, 1),
    l('Bar', 30),
    l('Bar', 20),
    l('Page', 2),
  ])
  assert.deepEqual(
    chain.map((c) => `${c.component}:${c.line}`),
    ['Button:9', 'Bar:30', 'Page:2'],
  )
  assert.equal(componentChain([l('A', 1), l('B', 1), l('C', 1)], 2).length, 2)
})

const base: ElementInfo = {
  tag: 'button',
  attrs: [
    ['type', 'button'],
    ['aria-label', '发送'],
  ],
  className: 'grid h-8 w-8',
  text: '',
  width: 32,
  height: 32.4,
  source: { file: 'web/src/components/chat/ChatComposer.tsx', line: 340, component: 'SendButton' },
  chain: [
    { file: 'web/src/components/chat/ChatComposer.tsx', line: 340, component: 'SendButton' },
    { file: 'web/src/components/chat/ChatComposer.tsx', line: 210, component: 'ChatComposer' },
  ],
  selector: 'div > button[aria-label="发送"]',
  styles: [['font-size', '14px（0.875rem）']],
  page: '#/tasks/t1',
}

test('formatElementRef：第一行是摘要，写清源码位置、组件层级和样式', () => {
  const text = formatElementRef(base)
  const lines = text.split('\n')
  assert.equal(lines[0], '界面元素 SendButton · <button> 发送')
  assert.ok(text.includes('- 源码：web/src/components/chat/ChatComposer.tsx:340，组件 SendButton'))
  assert.ok(
    text.includes(
      '- 组件层级（由内到外）：SendButton web/src/components/chat/ChatComposer.tsx:340 ← ChatComposer web/src/components/chat/ChatComposer.tsx:210',
    ),
  )
  assert.ok(text.includes('- 元素：<button type="button" aria-label="发送">，32×32'))
  assert.ok(text.includes('- 计算样式：font-size 14px（0.875rem）'))
  assert.ok(text.includes('- 页面：#/tasks/t1'))
  assert.ok(!text.includes('- 文字：'))
})

test('formatElementRef：外层继承的位置要说明；UI 设计控件让 AI 用设计工具改', () => {
  const inherited = formatElementRef({ ...base, text: '  很长\n的文字 ', source: { ...base.source!, inherited: true } })
  assert.match(inherited, /^界面元素 SendButton · <button> 「很长 的文字」/)
  assert.ok(inherited.includes('第三方组件渲染'))
  const widget = formatElementRef({ ...base, widget: { id: 'w1', type: 'Button' } })
  assert.match(widget, /^UI 设计控件 Button · <button> 发送/)
  assert.ok(widget.includes('控件 id：w1（类型 Button）'))
  assert.ok(!widget.includes('- 源码：'))
})

test('pickStyles：去掉默认值，字号同时给 rem', () => {
  const css: Record<string, string> = {
    display: 'flex',
    position: 'static',
    'font-size': '13px',
    'font-weight': '400',
    color: 'rgb(0, 0, 0)',
    'background-color': 'rgba(0, 0, 0, 0)',
    padding: '0px',
    border: '0px none rgb(0, 0, 0)',
    opacity: '1',
    'border-radius': '8px',
  }
  assert.deepEqual(
    pickStyles((p) => css[p] ?? '', 16),
    [
      ['display', 'flex'],
      ['font-size', '13px（0.8125rem）'],
      ['color', 'rgb(0, 0, 0)'],
      ['border-radius', '8px'],
    ],
  )
})
