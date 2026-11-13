/**
 * 界面检查（01-composer 用）：粘贴图片后在卡片紧后面用输入法打拼音、再清掉，光标不能掉进卡片里。
 * 以前 Chrome 在组合结束后把光标落在卡片内部：退格删不掉卡片、上屏的字丢掉，
 * 再粘贴的内容插进卡片里面，卡片外壳还在、文件名被挤没了（修复见 web/src/components/chat/chip-caret.ts）。
 * 用 CDP 的 Input.imeSetComposition 模拟输入法，两种结束方式都测：
 * 正常清空组合（有 compositionend）和组合被普通按键打断（没有 compositionend）。
 */
import { TINY_PNG } from './harness.mjs'

/** 往输入框粘贴一张剪贴板截图（和系统截图粘贴一样只有文件，没有文字） */
async function pasteImage(p, selector) {
  await p.evaluate(
    ({ png, selector }) => {
      const bin = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bin], 'image.png', { type: 'image/png' }))
      document
        .querySelector(selector)
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { png: TINY_PNG.toString('base64'), selector },
  )
}

/** 光标是不是停在某张卡片里面 */
const caretInChip = (p) =>
  p.evaluate(() => {
    const n = getSelection()?.anchorNode
    const el = n && (n.nodeType === 1 ? n : n.parentElement)
    return !!el?.closest('[data-chip]')
  })

export async function checkImeAfterChip(p, errors, selector = '#task-prompt') {
  const cdp = await p.context().newCDPSession(p)
  const box = p.locator(selector)
  const chip = p.locator(`${selector} [data-chip="image"]`)
  const cases = [
    {
      name: '输入法清空拼音',
      clear: () => cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }),
    },
    {
      name: '组合被打断',
      clear: async () => {
        await p.keyboard.press('Backspace')
        await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      },
    },
  ]
  for (const c of cases) {
    await box.click()
    await box.fill('')
    await pasteImage(p, selector)
    await chip.waitFor({ timeout: 10000 }).catch(() => errors.push(`卡片后输入法-${c.name}：粘贴图片后没有卡片`))
    // 等上传完、卡片换成路径：用户遇到时多半是这个时候
    await p
      .waitForFunction(
        (s) => /[\\/]/.test(document.querySelector(`${s} [data-chip-main]`)?.textContent ?? ''),
        selector,
        {
          timeout: 10000,
        },
      )
      .catch(() => {})
    await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
    await c.clear()
    // 选区变化是异步事件：等它处理完再看
    await p.waitForTimeout(100)
    if (await caretInChip(p)) errors.push(`卡片后输入法-${c.name}：光标掉进了卡片里面`)
    await p.keyboard.press('Backspace')
    await chip
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => errors.push(`卡片后输入法-${c.name}：按退格删不掉卡片`))
  }
  // 光标掉进卡片后再粘贴：新内容不能插进卡片里面（卡片名字会被挤没）
  await box.fill('')
  await pasteImage(p, selector)
  await chip.waitFor({ timeout: 10000 }).catch(() => {})
  await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await pasteImage(p, selector)
  await p.waitForTimeout(200)
  if (await p.locator(`${selector} [data-chip] [data-chip]`).count())
    errors.push('卡片后输入法-再粘贴：新卡片插进了旧卡片里面')
  if ((await chip.count()) !== 2) errors.push(`卡片后输入法-再粘贴：应该有两张图片卡片（${await chip.count()}）`)
  await box.fill('')
  await cdp.detach()
}
