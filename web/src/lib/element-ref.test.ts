/** 元素抓取写给 AI 的引用：位置解析、组件层级去重、拼出来的文字 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  componentChain,
  ELEMENT_REF_MARK,
  formatElementRef,
  isElementRefText,
  parseElementRef,
  parseLoc,
  pasteElementRefs,
  pickStyles,
  wrapElementRef,
  type ElementInfo,
} from '@/lib/element-ref'

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

const ref = formatElementRef(base)

test('wrapElementRef：头标记和正文同一行、尾标记独占一行，原文一字不动', () => {
  const wrapped = wrapElementRef(ref)
  assert.equal(wrapped, `${ELEMENT_REF_MARK.head}${ref}\n${ELEMENT_REF_MARK.tail}`)
  // 去掉标记就是 formatElementRef 的原始输出
  assert.equal(wrapped.slice(ELEMENT_REF_MARK.head.length, -ELEMENT_REF_MARK.tail.length - 1), ref)
})

test('wrapElementRef：已经带标记的不再包一层；空文字不包', () => {
  const once = wrapElementRef(ref)
  assert.equal(wrapElementRef(once), once)
  assert.equal(wrapElementRef('  '), '  ')
})

test('parseElementRef：整段就是一条引用时还原出原文', () => {
  const hits = parseElementRef(wrapElementRef(ref))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].text, ref)
  assert.equal(hits[0].start, 0)
  assert.equal(hits[0].end, wrapElementRef(ref).length)
})

test('parseElementRef：前后有别的文字时只取引用那一段，位置对得上', () => {
  const value = `看看这个\n${wrapElementRef(ref)}\n再改`
  const [hit, ...rest] = parseElementRef(value)
  assert.equal(rest.length, 0)
  assert.equal(value.slice(hit.start, hit.end), wrapElementRef(ref))
  assert.equal(hit.text, ref)
})

test('parseElementRef：标记不完整、内部被改坏、缺摘要行都不认', () => {
  // 只复制了开头一半
  const half = wrapElementRef(ref).slice(0, 60)
  assert.deepEqual(parseElementRef(half), [])
  // 只有结尾标记
  assert.deepEqual(parseElementRef(`\n${ELEMENT_REF_MARK.tail}`), [])
  // 里面的内容不是元素引用（第一行不是摘要、没有「- 元素：」）
  assert.deepEqual(parseElementRef(`${ELEMENT_REF_MARK.head}随便一段话\n${ELEMENT_REF_MARK.tail}`), [])
})

test('parseElementRef：同一段里多条引用都认出来', () => {
  const other = wrapElementRef(formatElementRef({ ...base, text: '另一个' }))
  const value = `${wrapElementRef(ref)}\n\n${other}`
  const hits = parseElementRef(value)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].text, ref)
  assert.equal(hits[1].text, formatElementRef({ ...base, text: '另一个' }))
})

test('parseElementRef：普通文字里出现一半标记不会把它吃掉', () => {
  const value = `我在讲 ${ELEMENT_REF_MARK.head} 这个写法`
  assert.deepEqual(parseElementRef(value), [])
})

test('parseElementRef：孤立的头标记不会把后面完整的引用一起跳过', () => {
  // 先粘过一半、又把标记写法讲了一句，紧接着才是真正要还原的引用
  const value = `${ELEMENT_REF_MARK.head}我在讲这个写法\n${wrapElementRef(ref)}`
  const hits = parseElementRef(value)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].text, ref)
  assert.deepEqual(pasteElementRefs(value, () => 'A#q1')?.text, `[元素引用]我在讲这个写法\n[引用:A#q1]`)
})

test('isElementRefText：按第一行摘要和「- 元素：」认，普通文字返回 false', () => {
  assert.equal(isElementRefText(ref), true)
  assert.equal(isElementRefText(formatElementRef({ ...base, widget: { id: 'w1' } })), true)
  assert.equal(isElementRefText('界面元素 这是我自己写的\n没有别的'), false)
  assert.equal(isElementRefText(''), false)
})

test('pasteElementRefs：每块引用换成卡片标记，其余文字原样保留', () => {
  const value = `看看这个\n${wrapElementRef(ref)}\n再改`
  const out = pasteElementRefs(value, () => '界面元素 SendButton · <button> 发送#qabc')
  assert.equal(out?.text, `看看这个\n[引用:界面元素 SendButton · <button> 发送#qabc]\n再改`)
  assert.deepEqual([out?.made, out?.kept], [1, 0])
})

test('pasteElementRefs：引用在末尾时不凭空多一个尾空格', () => {
  const out = pasteElementRefs(`看这个\n${wrapElementRef(ref)}`, () => 'A#q1')
  assert.equal(out?.text, '看这个\n[引用:A#q1]')
})

test('pasteElementRefs：回调给不出名字时原文照旧、made 是 0（调用方不拦阻粘贴）', () => {
  const value = wrapElementRef(ref)
  const out = pasteElementRefs(value, () => undefined)
  assert.equal(out?.text, value)
  assert.deepEqual([out?.made, out?.kept], [0, 1])
})

test('pasteElementRefs：只有一部分换来卡片标记时，没换的那块原文留在原位', () => {
  const other = formatElementRef({ ...base, text: '另一个' })
  const value = `${wrapElementRef(ref)}\n\n${wrapElementRef(other)}`
  // 只给第一块名字
  const out = pasteElementRefs(value, (t) => (t === other ? undefined : 'A#q1'))
  assert.equal(out?.text, `[引用:A#q1]\n\n${wrapElementRef(other)}`)
  // kept 让调用方知道有一块没换成卡片，不用去结果文字里搜标记（用户自己写的标记会误报）
  assert.deepEqual([out?.made, out?.kept], [1, 1])
})

test('pasteElementRefs：一块都没认出时返回 undefined，交给原来的粘贴流程', () => {
  assert.equal(
    pasteElementRefs('就是一段普通文字', () => 'x#q1'),
    undefined,
  )
  assert.equal(
    pasteElementRefs(wrapElementRef(ref).slice(0, 40), () => 'x#q1'),
    undefined,
  )
})

test('pasteElementRefs：只换名额内的那几块，后面的引用原文留在原位不丢', async () => {
  const { MAX_ATTACHMENTS } = await import('@shared/schema')
  const one = formatElementRef(base)
  const value = Array.from({ length: MAX_ATTACHMENTS + 2 }, () => wrapElementRef(one)).join('\n')
  let asked = 0
  const out = pasteElementRefs(value, () => `R${++asked}#q${asked}`, MAX_ATTACHMENTS)
  // 只建这么多个卡片，超出的不调回调（少建一张附件就少一条发不出去的消息）
  assert.equal(asked, MAX_ATTACHMENTS)
  assert.ok(out)
  assert.equal(out.text.split('[/元素引用]').length - 1, 2, '超出的两张的原文不该丢')
  assert.equal(out.text.match(/\[引用:/g)?.length, MAX_ATTACHMENTS)
  assert.deepEqual([out.made, out.kept], [MAX_ATTACHMENTS, 2])
})
