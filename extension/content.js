// 运行在 Gemini / ChatGPT 页面里，听后台的指令：nav 在页面里切到新对话或某个对话（不刷新页面）；
// submit 在当前的新对话里写描述并发送，返回对话地址；prompt 在已有的对话里接着要一张新图；
// check 看当前对话里新出现的图片（能直接读的读成 data URL，否则给地址）；more 在这个对话里再要一版。
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

  // 生成的图放在这些域名上（Gemini 是 googleusercontent，ChatGPT 是 oaiusercontent）
  const IMAGE_HOST = /(googleusercontent\.com|oaiusercontent\.com)$/

  /**
   * 页面上「像生成结果」的图片：够大、不是头像和图标。
   * 标签页在后台时网页不渲染动画、懒加载也不触发，图片可能已经在回复里了，但显示尺寸是 0 或还没开始加载，
   * 所以回复里的图按原图尺寸判断，没加载的按地址判断（交给后台下载）
   */
  const candidates = () => {
    const inReply = new Set(replies().flatMap((r) => [...r.querySelectorAll('img')]))
    return [...document.querySelectorAll('img')].filter((img) => {
      const src = img.currentSrc || img.src
      if (!src || src.startsWith('data:image/svg')) return false
      // 用户自己上传的图（在用户消息里）不算
      if (img.closest('[data-message-author-role="user"], user-query')) return false
      if (inReply.has(img)) {
        if (img.complete && img.naturalWidth) return img.naturalWidth >= 200 && img.naturalHeight >= 200
        try {
          return IMAGE_HOST.test(new URL(src).hostname)
        } catch {
          return false
        }
      }
      const r = img.getBoundingClientRect()
      if (r.width < 120 || r.height < 120) return false
      return img.complete && img.naturalWidth >= 200
    })
  }

  /** 后台标签页里懒加载不会触发：把回复里的图改成立即加载 */
  const wakeImages = () => {
    for (const r of replies()) for (const img of r.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager'
  }

  const selectAll = (el) => {
    el.focus({ preventScroll: true })
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  const fireInput = (el, text) => {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /** 几种写入输入框的方式，send 里依次试 */
  const WRITE = [
    // 普通输入框直接设值；富文本（Quill、ProseMirror）用编辑命令插入，和打字一样会触发网页的输入处理
    async (el, text) => {
      if (el.tagName === 'TEXTAREA') {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        set.call(el, text)
        fireInput(el, text)
        return
      }
      selectAll(el)
      document.execCommand('insertText', false, text)
      await sleep(100)
    },
    // 模拟粘贴：ProseMirror 和 Quill 都处理粘贴事件
    async (el, text) => {
      if (el.tagName === 'TEXTAREA') return
      selectAll(el)
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      await sleep(200)
    },
    // 直接改内容：两种编辑器都会监听内容变化，同步进自己的状态
    async (el, text) => {
      if (el.tagName === 'TEXTAREA') return
      el.replaceChildren(
        ...text.split('\n').map((line) => {
          const p = document.createElement('p')
          if (line) p.textContent = line
          else p.append(document.createElement('br'))
          return p
        }),
      )
      fireInput(el, text)
      await sleep(200)
    },
  ]

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
   * 写描述并发送。不切换标签页：用户在面板里发消息时，不该被拉到 Gemini / ChatGPT 那边。
   * 后台标签页里写入的方式不一定都管用，一种不行换下一种，直到发送按钮能点
   */
  async function send(text) {
    // 新开的对话页面要等输入框渲染出来
    let input = $(INPUT[site])
    for (let i = 0; !input && i < 60; i++) {
      await sleep(500)
      input = $(INPUT[site])
    }
    if (!input) throw new Error('找不到输入框：请确认这个标签页已经登录，并停在聊天页面')
    const before = userMsgs()
    for (const way of WRITE) {
      await way(input, text)
      if (!inputText(input)) continue
      await submit(input)
      if (await sent(before, input)) return
    }
    throw new Error(
      '描述没能发出去：输入框或发送按钮没有反应，可能网页改版了。请看一下那个标签页的输入框里有没有这段描述',
    )
  }

  /** 点发送按钮；按钮一直不可用就按回车 */
  async function submit(input) {
    // 发送按钮要等输入框有内容、网页处理完输入事件后才可用
    for (let i = 0; i < 15; i++) {
      const btn = $(SEND[site])
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click()
        return
      }
      await sleep(200)
    }
    for (const type of ['keydown', 'keypress', 'keyup'])
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      )
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

  /** 这个对话里的图还不够几版：在同一个对话里再要一张 */
  async function more() {
    const n = replies().length
    await send('Generate one more variation of the same image with exactly the same requirements.')
    return { replies: n }
  }

  /**
   * 在已经开着的对话里接着要一张新图（每个标签页只开固定几个对话，图排队轮流用）。
   * 返回发之前对话里已有几张图、几条回复，取图时跳过它们
   */
  async function prompt(msg) {
    const start = Date.now()
    while (Date.now() - start < 10_000 && !replies().length) await sleep(300)
    wakeImages()
    await sleep(300)
    const base = { images: candidates().length, replies: replies().length }
    await send(
      `Now generate a new, separate image (use your image generation tool, output the image only). It is not a variation of the previous images:\n\n${msg.prompt}`,
    )
    return base
  }

  /** 对话自己的地址（左边对话列表里那一项）：Gemini 是 /app/<id>，ChatGPT 是 /c/<id> */
  const convUrl = () =>
    (site === 'gemini' ? /\/app\/[\w-]{6,}/ : /\/c\/[\w-]{6,}/).test(location.pathname) ? location.href : ''

  const REPLY = {
    gemini: ['model-response', 'message-content'],
    chatgpt: ['[data-message-author-role="assistant"]'],
  }
  const replies = () => {
    for (const sel of REPLY[site]) {
      const list = document.querySelectorAll(sel)
      if (list.length) return [...list]
    }
    return []
  }

  const NEW_CHAT = {
    gemini: [
      '[data-test-id="new-chat-button"] a',
      '[data-test-id="new-chat-button"] button',
      'button[aria-label*="New chat" i]',
      'a[aria-label*="New chat" i]',
      'button[aria-label*="新对话"]',
      'a[aria-label*="新对话"]',
    ],
    chatgpt: ['a[data-testid="create-new-chat-button"]', 'button[data-testid="create-new-chat-button"]'],
  }

  const pathOf = (url) => {
    try {
      return new URL(url, location.href).pathname.replace(/\/+$/, '') || '/'
    } catch {
      return ''
    }
  }

  /**
   * 在页面里切换对话，不刷新标签页：点网页自己的「新对话」按钮或左边对话列表里的那一项，
   * 都找不到（侧栏收起了）时改地址再通知网页的路由。等旧对话的内容从页面上消失才返回，免得把上一个对话的图算进来
   */
  async function nav(msg) {
    const want = pathOf(msg.url)
    if (pathOf(location.href) === want) return { ok: true }
    const fresh = !!msg.fresh
    const stale = replies()
    let el = fresh ? visibleOf(NEW_CHAT[site]) : null
    if (!el) el = [...document.querySelectorAll('a[href]')].find((a) => pathOf(a.href) === want && visible(a))
    if (el) el.click()
    else {
      history.pushState(history.state, '', msg.url)
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    }
    const start = Date.now()
    while (Date.now() - start < 10_000) {
      await sleep(300)
      const here = fresh ? !convUrl() : pathOf(location.href) === want
      if (here && stale.every((r) => !r.isConnected) && (!fresh || $(INPUT[site]))) return { ok: true }
    }
    return { ok: false }
  }

  const visibleOf = (sels) => {
    for (const s of sels) for (const el of document.querySelectorAll(s)) if (visible(el)) return el
    return null
  }

  /** 在新对话里发描述，等对话有了自己的地址就返回；图在网页那边接着生成，后台切去开下一个对话 */
  async function startChat(msg) {
    const progress = (text) => chrome.runtime.sendMessage({ type: 'progress', id: msg.id, text }).catch(() => {})
    progress('在新对话里发送描述')
    await send(`Please generate an image (use your image generation tool, output the image only):\n\n${msg.prompt}`)
    for (let i = 0; i < 60; i++) {
      const url = convUrl()
      if (url) return { url }
      await sleep(500)
    }
    throw new Error('描述发出去了，但网页没有生成新的对话，请看一下那个标签页')
  }

  /**
   * 看一下当前对话的结果：跳过已经取过的 skip 张，把新出现的图交回去。
   * 刚打开对话时内容要一会儿才渲染出来；图片数量 2.5 秒不变、也不在回复中才算出齐
   */
  async function check(msg) {
    const start = Date.now()
    while (Date.now() - start < 15_000 && !replies().length && !candidates().length) await sleep(500)
    let last = -1
    let quiet = Date.now()
    while (Date.now() - start < 30_000) {
      wakeImages()
      const n = candidates().length
      if (n !== last) {
        last = n
        quiet = Date.now()
      }
      if (busy() && n <= msg.skip) break
      if (!busy() && Date.now() - quiet > 2500) break
      await sleep(500)
    }
    const fresh = candidates().slice(msg.skip)
    const images = []
    for (const img of fresh) images.push(await grab(img))
    const r = replies()
    const text = (r[r.length - 1]?.innerText ?? '').trim()
    // 接着用的对话里，发描述之前的回复不算
    const replied = r.length > (msg.replyBase ?? 0) && !!text
    return { busy: busy(), images, replied, text: replied ? text.slice(0, 200) : '' }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'ping') {
      reply({ ok: true, site })
      return false
    }
    const run = { nav, submit: startChat, prompt, check, more }[msg?.type]
    if (run) {
      run(msg)
        .then((r) => reply(r ?? {}))
        .catch((e) => reply({ error: String(e?.message ?? e) }))
      return true
    }
    return false
  })
}
