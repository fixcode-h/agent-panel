// Agent 面板 · 网页生图扩展的后台。
// 把 Gemini / ChatGPT 的标签页报给本机的 Agent 面板（http://127.0.0.1:<端口>/api/bridge），
// 从面板取「生成图片」的指令，交给对应标签页里的 content.js 去输入描述、等图出来，
// 再把图片取回来（需要时抠掉纯绿底）、转成 PNG 交给面板。只认这两个网站，别的标签页不碰。

const DEFAULT_PORT = 8787
const SITES = ['https://gemini.google.com/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let state = { connected: false, error: '', tabs: 0 }
let polling = false
let busy = false

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

async function listTabs() {
  const tabs = await chrome.tabs.query({ url: SITES })
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
      if (!state.tabs && !busy) break
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
  // 标签页里的进度转给面板
  if (msg?.type === 'progress' && msg.id) {
    void post('progress', { id: msg.id, text: msg.text }).catch(() => {})
  }
  return false
})

/** 页面是在扩展装好之前打开的，里面没有 content.js：补注入一次 */
async function ensureContent(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' })
    if (r?.ok) return
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
}

async function handle(cmd) {
  busy = true
  try {
    await post('progress', { id: cmd.id, text: '已收到，准备在网页里生成' })
    const tabId = Number(cmd.tabId)
    await ensureContent(tabId)
    const res = await chrome.tabs.sendMessage(tabId, {
      type: 'generate',
      id: cmd.id,
      prompt: cmd.prompt,
      count: cmd.count,
    })
    if (!res || res.error) throw new Error(res?.error || '网页没有回应，刷新一下那个标签页再试')
    const images = []
    for (const img of res.images) {
      const blob = img.data ? await (await fetch(img.data)).blob() : await download(img.src)
      images.push({ data: await toPng(blob, cmd.chroma) })
    }
    await post('result', { id: cmd.id, ok: true, images })
  } catch (e) {
    await post('result', { id: cmd.id, ok: false, error: String(e?.message ?? e) }).catch(() => {})
  } finally {
    busy = false
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
