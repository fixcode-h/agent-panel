/** 复制 / 剪切写剪贴板时的两种格式：纯文本给面板自己，HTML 给 Word、Excel 这类富文本目标 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipboardText, escapeHtml, setClipboardText, textToHtml } from '@/lib/clipboard-text'
import { wrapElementRef } from '@/lib/element-ref'

/** 剪贴板事件的 dataTransfer 在单测里用一个收集写入的假对象代替 */
function clipboard() {
  const data = new Map<string, string>()
  return {
    data,
    setData: (type: string, value: string) => void data.set(type, value),
  }
}

test('textToHtml：换行变成 br，行首缩进和连续空格原样保留', () => {
  const html = textToHtml('第一行\n  缩进两格  中间两个空格\n第三行')
  assert.equal(html, '<div style="white-space: pre-wrap">第一行<br>  缩进两格  中间两个空格<br>第三行</div>')
  // 只靠 <br> 分行，不用 <p>：Word、Excel 里 <p> 会带上一堆自己的段距
  assert.ok(!html.includes('<p'))
})

test('textToHtml：HTML 特殊字符转义，粘贴目标不会把正文当成标签', () => {
  const html = textToHtml('if (a < b && c > d) return "x"')
  assert.ok(html.includes('a &lt; b &amp;&amp; c &gt; d'))
  assert.ok(html.includes('&quot;x&quot;'))
  assert.ok(!html.includes('<b'))
  assert.equal(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;')
})

test('clipboardText：两种格式的内容是同一份文字，HTML 里是全文不是截断', () => {
  const long = '继续输入要求 '.repeat(20)
  const copied = clipboardText(long)
  assert.equal(copied['text/plain'], long)
  // 去掉包裹的 div 和换行标签就是原文：一个字都不能少
  const back = copied['text/html'].replace(/^<div style="white-space: pre-wrap">/, '').replace(/<\/div>$/, '')
  assert.equal(back, long)
  assert.equal(copied['text/html'].length > long.length, true)
})

test('clipboardText：引用卡片复制出去时，两份都带完整原文和标记（不是卡片上的 40 字摘要）', () => {
  // 卡片选中复制走 RichInput 的 onCopy：文字由 serialize(chipText) 造出来，再交给 clipboardText。
  // 这里只覆盖「两份格式装的是同一份原文」这一层，造文字那一步的用例在 element-ref.test.ts
  const ref = '[元素引用]界面元素 RichInput · <div> 继续…\n- 选择器：div > div\n[/元素引用]'
  const copied = clipboardText(wrapElementRef(ref))
  for (const type of ['text/plain', 'text/html'] as const) {
    const v = copied[type]
    assert.ok(v.includes('界面元素 RichInput'), `${type} 里没有摘要行`)
    assert.ok(v.includes('- 选择器：'), `${type} 里没有摘要之后的行，像是只复制了卡片上那段摘要`)
    assert.ok(v.includes('[元素引用]') && v.includes('[/元素引用]'), `${type} 里没有标记，粘回输入框认不出卡片`)
  }
})

test('setClipboardText：text/plain 和 text/html 一起写进剪贴板', () => {
  const e = clipboard()
  setClipboardText(e, '第一行\n第二行')
  assert.deepEqual([...e.data.keys()].sort(), ['text/html', 'text/plain'])
  assert.equal(e.data.get('text/plain'), '第一行\n第二行')
  assert.equal(e.data.get('text/html'), textToHtml('第一行\n第二行'))
})
