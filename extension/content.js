// 运行在 Gemini / ChatGPT 页面里：收到后台的「生成图片」指令后，在输入框里写描述、发送、
// 等这一轮回复结束、找出新出现的图片，把图片（能直接读的读成 data URL，否则给地址）交回后台。
// 网页改版后选择器可能失效：每个都准备了几种写法，最后退到通用的判断（可编辑的输入框、aria-label 含 Stop 的按钮）。

if (!window.__agentPanelContent) {
  window.__agentPanelContent = true

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const site = location.hostname === 'gemini.google.com' ? 'gemini' : 'chatgpt'
  const $ = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s)
      if (el) return el
    }
    return null
  }
  const visible = (el) => !!el && el.getClientRects().length > 0

  const INPUT = {
    gemini: [
      'rich-textarea .ql-editor',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    chatgpt: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt-textarea"]'],
  }
  const SEND = {
    gemini: ['button.send-button', 'button[aria-label*="Send" i]', 'button[aria-label*="发送"]'],
    chatgpt: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send" i]'],
  }
  const STOP = {
    gemini: ['button[aria-label*="Stop" i]', 'button[aria-label*="停止"]', 'button.stop', 'mat-icon[fonticon="stop"]'],
    chatgpt: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]', 'button[aria-label*="停止"]'],
  }

  // 用户发出去的消息：发送后数量会加一，用来确认真的发出去了
  const USER_MSG = {
    gemini: ['user-query', '.user-query-container', '[data-test-id="user-query"]'],
    chatgpt: ['[data-message-author-role="user"]'],
  }
  const userMsgs = () => {
    for (const sel of USER_MSG[site]) {
      const n = document.querySelectorAll(sel).length
      if (n) return n
    }
    return 0
  }

  const busy = () => {
    if (visible($(STOP[site]))) return true
    // 选择器跟不上改版时的兜底：页面上有可见的「停止」按钮
    return [...document.querySelectorAll('button[aria-label]')].some(
      (b) => /^(stop|停止)/i.test(b.getAttribute('aria-label') ?? '') && visible(b),
    )
  }

  /** 页面上「像生成结果」的图片：够大、不是头像和图标 */
  const candidates = () =>
    [...document.querySelectorAll('img')].filter((img) => {
      const r = img.getBoundingClientRect()
      if (r.width < 120 || r.height < 120) return false
      if (!img.complete || img.naturalWidth < 200) return false
      const src = img.currentSrc || img.src
      if (!src || src.startsWith('data:image/svg')) return false
      // 用户自己上传的图（在用户消息里）不算
      if (img.closest('[data-message-author-role="user"], user-query')) return false
      return true
    })
  const keyOf = (img) => img.currentSrc || img.src

  async function typeInto(el, text) {
    el.focus()
    if (el.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    // 富文本输入框（Quill、ProseMirror）：先选中原有内容再插入，插不进去时模拟粘贴
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
    document.execCommand('insertText', false, text)
    await sleep(100)
    if (!el.innerText.trim()) {
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      await sleep(100)
    }
    if (!el.innerText.trim()) {
      el.textContent = text
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
  }

  const inputText = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText).trim()

  /** 确认发出去了：出现了新的用户消息、开始回复，或者输入框被清空 */
  async function sent(before, input) {
    for (let i = 0; i < 25; i++) {
      await sleep(200)
      if (userMsgs() > before || busy() || !inputText(input)) return true
    }
    return false
  }

  /**
   * 写描述并发送。标签页在后台时，有的输入框不接受程序写入，发送按钮一直是灰的（以前报「网页没有开始回复」
   * 多半就是这样）：发不出去时让后台把这个标签页切到前面，再发一次，发完切回去
   */
  async function send(text, progress) {
    // 新开的对话页面要等输入框渲染出来
    let input = $(INPUT[site])
    for (let i = 0; !input && i < 60; i++) {
      await sleep(500)
      input = $(INPUT[site])
    }
    if (!input) throw new Error('找不到输入框：请确认这个标签页已经登录，并停在聊天页面')
    const before = userMsgs()
    await submit(input, text)
    if (await sent(before, input)) return
    progress('切到这个标签页发送描述')
    await chrome.runtime.sendMessage({ type: 'focus' }).catch(() => {})
    try {
      await sleep(400)
      input = $(INPUT[site]) ?? input
      await submit(input, text)
      if (await sent(before, input)) return
    } finally {
      chrome.runtime.sendMessage({ type: 'unfocus' }).catch(() => {})
    }
    throw new Error(
      '描述没能发出去：输入框或发送按钮没有反应，可能网页改版了。请看一下那个标签页的输入框里有没有这段描述',
    )
  }

  async function submit(input, text) {
    await typeInto(input, text)
    // 发送按钮要等输入框有内容后才可用
    for (let i = 0; i < 30; i++) {
      const btn = $(SEND[site])
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click()
        return
      }
      await sleep(200)
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
  }

  /** 等这一轮回复结束：出现过「停止」按钮后它消失，或者有新图片且一段时间没有变化 */
  async function waitRound(before, progress) {
    const start = Date.now()
    let sawBusy = false
    let quietSince = 0
    let lastCount = -1
    while (Date.now() - start < 5 * 60_000) {
      await sleep(1000)
      const b = busy()
      if (b) sawBusy = true
      const fresh = candidates().filter((img) => !before.has(keyOf(img)))
      if (fresh.length !== lastCount) {
        lastCount = fresh.length
        quietSince = Date.now()
      }
      const sec = Math.round((Date.now() - start) / 1000)
      if (sec % 10 === 0) progress(`等待网页生成（${sec} 秒）`)
      // 结束了：不忙、有新图、图片 3 秒没变（ChatGPT 会先出模糊的预览图再换成清晰的）
      if (!b && fresh.length && Date.now() - quietSince > 3000) return fresh
      // 回复结束了却没有图：多半是被拒绝或需要会员
      if (!b && sawBusy && !fresh.length && Date.now() - start > 8000) {
        await sleep(3000)
        const again = candidates().filter((img) => !before.has(keyOf(img)))
        if (again.length) return again
        throw new Error('这一轮回复结束了，但没有出现图片。请看一下网页上的回复（可能被拒绝，或这个账号不能生成图片）')
      }
      // 描述已经确认发出去了：看不到「停止」按钮（网页改版）时也接着等图片，只在很久都没动静时报错
      if (!b && !sawBusy && Date.now() - start > 3 * 60_000 && !fresh.length)
        throw new Error('描述发出去了，但 3 分钟内网页上没有出现回复或图片，请看一下那个标签页')
    }
    throw new Error('等了 5 分钟还没生成完')
  }

  /** 能在页面里直接读的图片读成 data URL（blob:、同源），其余把地址交给后台下载 */
  async function grab(img) {
    const src = img.currentSrc || img.src
    try {
      if (src.startsWith('blob:') || src.startsWith('data:') || new URL(src).origin === location.origin) {
        const blob = await (await fetch(src, { credentials: 'include' })).blob()
        const data = await new Promise((res, rej) => {
          const fr = new FileReader()
          fr.onload = () => res(fr.result)
          fr.onerror = rej
          fr.readAsDataURL(blob)
        })
        return { data }
      }
    } catch {}
    return { src }
  }

  async function generate(msg) {
    const progress = (text) => chrome.runtime.sendMessage({ type: 'progress', id: msg.id, text }).catch(() => {})
    const out = []
    for (let i = 0; i < msg.count; i++) {
      if (busy()) throw new Error('这个标签页正在回复别的内容，等它结束后再试')
      const before = new Set(candidates().map(keyOf))
      const text =
        i === 0
          ? `Please generate an image (use your image generation tool, output the image only):\n\n${msg.prompt}`
          : 'Generate one more variation of the same image with exactly the same requirements.'
      progress(msg.count > 1 ? `发送第 ${i + 1}/${msg.count} 张的描述` : '发送描述')
      await send(text, progress)
      const fresh = await waitRound(before, progress)
      // 一轮可能出多张图，都收下
      for (const img of fresh) {
        const g = await grab(img)
        out.push(g)
        // 取到一张就先交出去，面板马上能放进设计里
        chrome.runtime.sendMessage({ type: 'image', id: msg.id, index: out.length - 1, img: g }).catch(() => {})
      }
      if (out.length >= msg.count) break
    }
    return out.slice(0, Math.max(msg.count, 1))
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'ping') {
      reply({ ok: true, site })
      return false
    }
    if (msg?.type === 'generate') {
      generate(msg)
        .then((images) => reply({ images }))
        .catch((e) => reply({ error: String(e?.message ?? e) }))
      return true
    }
    return false
  })
}
