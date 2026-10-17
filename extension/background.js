// Agent 面板 · 网页生图扩展的后台。
// 把 Gemini / ChatGPT 的标签页报给本机的 Agent 面板（http://127.0.0.1:<端口>/api/bridge），
// 从面板取「生成图片」的指令，交给对应标签页里的 content.js 去输入描述、等图出来，
// 再把图片取回来（需要时抠掉纯绿底）、转成 PNG 交给面板。只认这两个网站，别的标签页不碰。

const DEFAULT_PORT = 8787
const SITES = ['https://gemini.google.com/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let state = { connected: false, error: '', tabs: 0 }
let polling = false
// 正在处理的指令数：每张图在新对话里生成，可以同时处理好几个
let active = 0

async function base() {
  const { port } = await chrome.storage.local.get('port')
  return `http://127.0.0.1:${port || DEFAULT_PORT}/api/bridge`
}

async function post(path, body) {
  const r = await fetch(`${await base()}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// 为生成图片新开的标签页：不报给面板，免得出现在标签页列表里
const generating = new Set()

async function listTabs() {
  const tabs = (await chrome.tabs.query({ url: SITES })).filter((t) => !generating.has(t.id))
  return tabs.map((t) => ({ id: String(t.id), title: t.title ?? '', url: t.url ?? '' }))
}

async function hello() {
  try {
    const tabs = await listTabs()
    state.tabs = tabs.length
    await post('hello', { version: chrome.runtime.getManifest().version, tabs })
    state.connected = true
    state.error = ''
  } catch (e) {
    state.connected = false
    state.error = String(e?.message ?? e)
  }
  return state
}

// 长轮询取指令。浏览器会让空闲的后台休眠，这里每几秒调一次扩展接口（报标签页）让它保持运行；
// 没有 Gemini / ChatGPT 标签页时就不保持了，靠定时器每半分钟醒一次
async function loop() {
  if (polling) return
  polling = true
  const keep = setInterval(() => void hello(), 5000)
  try {
    for (;;) {
      await hello()
      if (!state.tabs && !active) break
      if (!state.connected) {
        await sleep(4000)
        continue
      }
      try {
        const r = await fetch(`${await base()}/poll`)
        const j = await r.json()
        if (j.cmd) void handle(j.cmd)
      } catch {
        await sleep(3000)
      }
    }
  } finally {
    clearInterval(keep)
    polling = false
  }
}

chrome.alarms.create('wake', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => void loop())
chrome.runtime.onStartup.addListener(() => void loop())
chrome.runtime.onInstalled.addListener(() => void loop())
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.title || info.url) void hello().then(() => loop())
})
chrome.tabs.onRemoved.addListener(() => void hello())

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // 弹出窗口要状态
  if (msg?.type === 'status') {
    void hello().then((s) => {
      void loop()
      reply(s)
    })
    return true
  }
  // 标签页在后台发不出描述：切到前面发，发完切回原来的标签页。同时只切一个，免得几个对话抢着切
  if (msg?.type === 'focus' && sender.tab?.id !== undefined) {
    void focusTab(sender.tab).then(
      () => reply(true),
      () => reply(false),
    )
    return true
  }
  if (msg?.type === 'unfocus' && sender.tab?.id !== undefined) {
    void unfocusTab(sender.tab.id)
    return false
  }
  // 标签页里每取到一张图就先交给面板，不等全部生成完
  if (msg?.type === 'image' && msg.id && msg.img) {
    const st = streamed.get(msg.id)
    if (st && !st.sent.has(msg.index)) {
      st.sent.add(msg.index)
      st.tasks.push(sendImage(msg.id, msg.img, st.chroma).catch(() => st.sent.delete(msg.index)))
    }
  }
  // 标签页里的进度转给面板
  if (msg?.type === 'progress' && msg.id) {
    void post('progress', { id: msg.id, text: msg.text }).catch(() => {})
  }
  return false
})

let focusLock = Promise.resolve()
const focusRelease = new Map()

async function focusTab(tab) {
  let release
  const mine = new Promise((r) => (release = r))
  const wait = focusLock
  focusLock = focusLock.then(() => mine)
  await wait
  const [cur] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
  focusRelease.set(tab.id, { release, prev: cur?.id })
  // 最多占 20 秒，标签页没发 unfocus 也会放开
  setTimeout(() => void unfocusTab(tab.id), 20_000)
  await chrome.tabs.update(tab.id, { active: true })
}

async function unfocusTab(tabId) {
  const f = focusRelease.get(tabId)
  if (!f) return
  focusRelease.delete(tabId)
  if (f.prev !== undefined && f.prev !== tabId) await chrome.tabs.update(f.prev, { active: true }).catch(() => {})
  f.release()
}

/** 页面是在扩展装好之前打开的，里面没有 content.js：补注入一次 */
async function ensureContent(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' })
    if (r?.ok) return
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
}

/** 每个指令已经单独交过的图片（按序号），最后的结果里不再重复交 */
const streamed = new Map()

async function sendImage(id, img, chroma) {
  const blob = img.data ? await (await fetch(img.data)).blob() : await download(img.src)
  await post('image', { id, data: await toPng(blob, chroma) })
}

/** 新对话的地址：Gemini 保留多账号的 /u/<n> 前缀 */
function newChatUrl(url) {
  const u = new URL(url)
  if (u.hostname === 'gemini.google.com') {
    const acc = u.pathname.match(/^\/u\/\d+/)?.[0] ?? ''
    return `${u.origin}${acc}/app`
  }
  return `${u.origin}/`
}

/** 等标签页加载完 */
function waitLoaded(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(on)
      resolve()
    }
    const on = (id, info) => id === tabId && info.status === 'complete' && done()
    const timer = setTimeout(done, 30_000)
    chrome.tabs.onUpdated.addListener(on)
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done(), done)
  })
}

async function handle(cmd) {
  active++
  const st = { sent: new Set(), tasks: [], chroma: cmd.chroma }
  streamed.set(cmd.id, st)
  // 每张图在选中标签页旁边新开一个对话，不在同一个对话里排队；生成完关掉，失败的留着方便查看
  let opened
  try {
    await post('progress', { id: cmd.id, text: '已收到，准备在网页里生成' })
    let tabId = Number(cmd.tabId)
    if (cmd.newChat) {
      const src = await chrome.tabs.get(tabId)
      const tab = await chrome.tabs.create({
        url: newChatUrl(src.url),
        windowId: src.windowId,
        index: src.index + 1,
        active: false,
      })
      opened = tab.id
      generating.add(tab.id)
      tabId = tab.id
      await post('progress', { id: cmd.id, text: '已打开新对话' })
      await waitLoaded(tabId)
    }
    await ensureContent(tabId)
    const res = await chrome.tabs.sendMessage(tabId, {
      type: 'generate',
      id: cmd.id,
      prompt: cmd.prompt,
      count: cmd.count,
    })
    if (!res || res.error) throw new Error(res?.error || '网页没有回应，刷新一下那个标签页再试')
    await Promise.all(st.tasks)
    const images = []
    for (const [i, img] of res.images.entries()) {
      if (st.sent.has(i)) continue
      const blob = img.data ? await (await fetch(img.data)).blob() : await download(img.src)
      images.push({ data: await toPng(blob, cmd.chroma) })
    }
    await post('result', { id: cmd.id, ok: true, images, streamed: st.sent.size })
    if (opened) await chrome.tabs.remove(opened).catch(() => {})
  } catch (e) {
    await post('result', { id: cmd.id, ok: false, error: String(e?.message ?? e) }).catch(() => {})
  } finally {
    streamed.delete(cmd.id)
    if (opened) generating.delete(opened)
    active--
  }
}

/** 图片在别的域名上（googleusercontent），由扩展带着登录状态下载；Gemini 的缩略图地址换成原图 */
async function download(src) {
  const tries = []
  if (/googleusercontent\.com/.test(src) && /=[swh]\d+[^/]*$/.test(src)) tries.push(src.replace(/=[^=/]*$/, '=s0'))
  tries.push(src)
  let last
  for (const u of tries) {
    try {
      const r = await fetch(u, { credentials: 'include' })
      if (r.ok) return await r.blob()
      last = new Error(`下载图片失败（HTTP ${r.status}）`)
    } catch (e) {
      last = e
    }
  }
  throw last
}

/** 转成 PNG；chroma 时把纯绿底抠成透明，并去掉边缘的绿色溢色 */
async function toPng(blob, chroma) {
  const bmp = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(bmp, 0, 0)
  if (chroma) {
    const d = g.getImageData(0, 0, bmp.width, bmp.height)
    keyOut(d)
    g.putImageData(d, 0, 0)
  }
  const out = await c.convertToBlob({ type: 'image/png' })
  return `data:image/png;base64,${b64(new Uint8Array(await out.arrayBuffer()))}`
}

function keyOut(img) {
  const { data, width: w, height: h } = img
  // 用四个角的颜色当底色；不是绿色（模型没照做）就不抠
  let r = 0
  let gg = 0
  let b = 0
  let n = 0
  for (const [x0, y0] of [
    [0, 0],
    [w - 6, 0],
    [0, h - 6],
    [w - 6, h - 6],
  ])
    for (let y = y0; y < y0 + 6; y++)
      for (let x = x0; x < x0 + 6; x++) {
        const i = (y * w + x) * 4
        r += data[i]
        gg += data[i + 1]
        b += data[i + 2]
        n++
      }
  r /= n
  gg /= n
  b /= n
  const keyG = gg - Math.max(r, b)
  if (keyG < 80) return
  const lo = keyG * 0.3
  const hi = keyG * 0.7
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i]
    const G = data[i + 1]
    const B = data[i + 2]
    const green = G - Math.max(R, B)
    if (green <= lo) continue
    const a = green >= hi ? 0 : 1 - (green - lo) / (hi - lo)
    data[i + 3] = Math.round(data[i + 3] * a)
    // 去溢色：绿色压到不超过红蓝里大的那个
    data[i + 1] = Math.max(R, B)
  }
}

function b64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

void loop()
