// Agent 面板 · 网页生图扩展的后台。
// 把 Gemini / ChatGPT 的标签页报给本机的 Agent 面板（http://127.0.0.1:<端口>/api/bridge），
// 从面板取「生成图片」的指令，交给对应标签页里的 content.js 去输入描述、等图出来，
// 再把图片取回来（需要时抠掉纯绿底）、转成 PNG 交给面板。只认这两个网站，别的标签页不碰。

const DEFAULT_PORT = 8787
const SITES = ['https://gemini.google.com/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let state = { connected: false, error: '', tabs: 0 }
let polling = false
// 正在处理的指令数：每张图在同一个标签页里各开一个对话，可以同时生成好几张
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
  try {
    await post('progress', { id: cmd.id, text: '已收到，排队发送描述' })
    const got = await new Promise((resolve, reject) => {
      const d = driver(Number(cmd.tabId))
      d.queue.push({ cmd, resolve, reject, url: '', got: 0, start: 0, idle: 0 })
      void runDriver(d)
    })
    await post('result', { id: cmd.id, ok: true, images: [], streamed: got })
  } catch (e) {
    await post('result', { id: cmd.id, ok: false, error: String(e?.message ?? e) }).catch(() => {})
  } finally {
    active--
  }
}

/**
 * 每个标签页一个调度。一个标签页同一时间只能显示一个对话，所以都在这里排队：
 * 先把描述逐个发到新对话里（网页左边的对话列表会多出这些对话，图在网页那边同时生成），
 * 再轮流打开这些对话取图。同时有几个对话由面板设置里的「同时生成几张」决定（最多 10 个）
 */
const drivers = new Map()

function driver(tabId) {
  let d = drivers.get(tabId)
  if (!d) {
    d = { tabId, queue: [], convs: [], next: 0, running: false }
    drivers.set(tabId, d)
  }
  return d
}

async function runDriver(d) {
  if (d.running) return
  d.running = true
  try {
    while (d.queue.length || d.convs.length) {
      try {
        await chrome.tabs.get(d.tabId)
      } catch {
        const err = new Error('生成图片用的标签页被关掉了')
        for (const job of [...d.queue, ...d.convs]) job.reject(err)
        d.queue = []
        d.convs = []
        break
      }
      // 新的描述先发出去，让网页尽早开始生成
      if (d.queue.length) {
        const job = d.queue.shift()
        try {
          await startJob(d, job)
          d.convs.push(job)
        } catch (e) {
          job.reject(e)
        }
        continue
      }
      const job = d.convs[d.next++ % d.convs.length]
      let done
      try {
        done = await checkJob(d, job)
      } catch (e) {
        job.reject(e)
        done = true
      }
      if (done) d.convs.splice(d.convs.indexOf(job), 1)
      // 只剩一个对话时它就停在页面上，隔一会儿再看；几个对话时切换本身就要几秒
      if (d.convs.length === 1 && !d.queue.length) await sleep(3000)
    }
  } finally {
    d.running = false
    drivers.delete(d.tabId)
  }
}

/** 让标签页打开某个地址，等加载完、content.js 就绪；已经在这个地址上就不重新加载 */
async function openUrl(tabId, url) {
  const tab = await chrome.tabs.get(tabId)
  if (tab.url !== url) {
    await chrome.tabs.update(tabId, { url })
    await sleep(500)
    await waitLoaded(tabId)
  }
  await ensureContent(tabId)
}

async function ask(tabId, msg) {
  const res = await chrome.tabs.sendMessage(tabId, msg)
  if (!res || res.error) throw new Error(res?.error || '网页没有回应，刷新一下那个标签页再试')
  return res
}

async function startJob(d, job) {
  const { id, prompt } = job.cmd
  await post('progress', { id, text: '打开新对话' })
  const tab = await chrome.tabs.get(d.tabId)
  await openUrl(d.tabId, newChatUrl(tab.url))
  const res = await ask(d.tabId, { type: 'submit', id, prompt })
  job.url = res.url
  job.start = Date.now()
  await post('progress', { id, text: '描述已发出，网页正在生成' }).catch(() => {})
}

/** 打开这个对话看一眼：新出现的图马上交给面板；够了几版就结束。返回 true 表示这张图处理完了 */
async function checkJob(d, job) {
  const { id, count, chroma } = job.cmd
  await openUrl(d.tabId, job.url)
  const res = await ask(d.tabId, { type: 'check', id, skip: job.got })
  for (const img of res.images) {
    await sendImage(id, img, chroma)
    job.got++
  }
  if (job.got >= Math.max(count, 1)) {
    job.resolve(job.got)
    return true
  }
  const sec = Math.round((Date.now() - job.start) / 1000)
  if (!res.busy && res.images.length) {
    // 这一轮出图了但还不够几版：在同一个对话里再要一张
    await ask(d.tabId, { type: 'more', id })
    job.idle = 0
  } else if (!res.busy && res.replied && !res.images.length) {
    // 回复结束了却没有图：连着几次都这样才算失败（刚打开时回复可能还没渲染完）
    if (++job.idle >= 3 && sec > 60)
      throw new Error(
        `这一轮回复结束了，但没有出现图片（可能被拒绝，或这个账号不能生成图片）。网页的回复：${res.text || '（空）'}`,
      )
  } else job.idle = 0
  if (sec > 8 * 60) throw new Error('等了 8 分钟还没生成完，请看一下网页左边对应的那个对话')
  await post('progress', {
    id,
    text: job.got ? `已取到 ${job.got} 张，等待网页生成（${sec} 秒）` : `等待网页生成（${sec} 秒）`,
  }).catch(() => {})
  return false
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
