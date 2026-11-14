/**
 * 界面检查（01-composer 用）：Shift+Enter 换行后在新的一行打字、用输入法打标点。
 * 以前末尾的「\n」后面没有占位，Chrome 把输入位置规整回「\n」前面：字落回上一行，
 * 输入法打的标点先插一遍、上屏又插一遍，一个标点出来两个（修复见 web/src/components/chat/tail-break.ts）。
 * 用 CDP 的 Input.imeSetComposition 模拟输入法打标点（组合里就是标点，上屏同一个字）。
 */

/** 输入框的文字（innerText 会把占位的 <br> 算成换行，这里只拼文字节点） */
const textOf = (p, selector) =>
  p.locator(selector).evaluate((n) =>
    Array.from(n.childNodes)
      .map((c) => (c.nodeType === 3 ? c.nodeValue : c.dataset?.tail !== undefined ? '' : c.textContent))
      .join(''),
  )

export async function checkImeAfterNewline(p, errors, selector = '#task-prompt') {
  const cdp = await p.context().newCDPSession(p)
  const box = p.locator(selector)
  const cases = [
    { name: '打字', type: () => p.keyboard.type('x'), want: 'ab\nx' },
    {
      name: '输入法打标点',
      type: async () => {
        await cdp.send('Input.imeSetComposition', { text: '，', selectionStart: 1, selectionEnd: 1 })
        await cdp.send('Input.insertText', { text: '，' })
      },
      want: 'ab\n，',
    },
    {
      name: '输入法打字',
      type: async () => {
        await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
        await cdp.send('Input.insertText', { text: '你' })
      },
      want: 'ab\n你',
    },
  ]
  for (const c of cases) {
    await box.click()
    await box.fill('')
    await p.keyboard.type('ab')
    await p.keyboard.press('Shift+Enter')
    await c.type()
    await p.waitForTimeout(100)
    const got = await textOf(p, selector)
    if (got !== c.want) errors.push(`换行后${c.name}：应该是 ${JSON.stringify(c.want)}，实际 ${JSON.stringify(got)}`)
  }
  await box.fill('')
  await cdp.detach()
}
