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
let reloadWanted = false

async function base() {
  const { port } = await chrome.storage.local.get('port')
  return `http://127.0.0.1:${port || DEFAULT_PORT}/api/bridge`
}

/**
 * 配对令牌：面板写出扩展文件时一起写进 pairing.json，每个请求都带上。
 * 面板不认没带令牌的请求（Origin 谁都能伪造）；读不到时每次重读，面板重新写出文件后就能连上
 */
let pairing = ''
async function pairToken() {
  if (pairing) return pairing
  try {
    const r = await fetch(chrome.runtime.getURL('pairing.json'))
    pairing = String((await r.json()).token ?? '')
  } catch {
    pairing = ''
  }
  return pairing
}
async function headers(extra = {}) {
  return { ...extra, 'X-Panel-Bridge': await pairToken() }
}

async function post(path, body) {
  const r = await fetch(`${await base()}/${path}`, {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (r.status === 401) {
    // 令牌对不上（面板换了数据目录、扩展文件夹是旧的）：下次重读 pairing.json
    pairing = ''
    throw new Error('没有和面板配对：请在面板里点「刷新扩展」，或重新加载扩展')
  }
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
    const r = await post('hello', { version: chrome.runtime.getManifest().version, tabs })
    state.connected = true
    state.error = ''
    // 用户在面板里点了「刷新扩展」；正在生成时不打断，下次报到再说（面板那边的要求只带一次，所以记下来）
    if (r?.reload) reloadWanted = true
    if (reloadWanted && !active) chrome.runtime.reload()
    void selfUpdate(r?.latestVersion)
  } catch (e) {
    state.connected = false
    state.error = String(e?.message ?? e)
  }
  return state
}

const newer = (a, b) => {
  const x = String(a).split('.').map(Number)
  const y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

/**
 * 面板更新后扩展文件夹里已经是新版，但浏览器不会自己重新加载已解压的扩展，旧代码会一直跑下去：
 * 看到面板自带的版本更新就重新加载一次。正在生成时不打断；每个版本只试一次，免得文件夹没更新时反复重载
 */
async function selfUpdate(latest) {
  if (!latest || active || !newer(latest, chrome.runtime.getManifest().version)) return
  const { reloadedFor } = await chrome.storage.local.get('reloadedFor')
  if (reloadedFor === latest) return
  await chrome.storage.local.set({ reloadedFor: latest })
  chrome.runtime.reload()
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
        const r = await fetch(`${await base()}/poll`, { headers: await headers() })
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
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
      d.queue.push({ cmd, resolve, reject, conv: null, got: 0, base: 0, replyBase: 0, start: 0, idle: 0 })
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
 * 每个标签页一个调度。一个标签页同一时间只能显示一个对话，所以都在这里排队。
 * 每个标签页只开固定几个对话（面板设置里的「同时生成几张」，最多 10 个），之后的图排队，
 * 哪个对话空下来就在哪个对话里接着生成，不会每张图都开一个新对话。描述发出去后轮流打开这些对话取图
 */
const drivers = new Map()
/** 每个标签页开过的对话：{ url, job }，job 为空表示这个对话空着；生成完也留着，下次接着用 */
const pools = new Map()

async function poolOf(tabId) {
  if (!pools.has(tabId)) {
    // 后台被浏览器休眠后内存清空了：从会话存储里恢复，接着用原来那几个对话
    const key = `pool:${tabId}`
    const saved = (await chrome.storage.session.get(key).catch(() => ({})))[key]
    if (!pools.has(tabId))
      pools.set(
        tabId,
        (saved ?? []).map((url) => ({ url, job: null })),
      )
  }
  return pools.get(tabId)
}
function savePool(tabId) {
  const urls = (pools.get(tabId) ?? []).map((c) => c.url).filter(Boolean)
  void chrome.storage.session.set({ [`pool:${tabId}`]: urls }).catch(() => {})
}
chrome.tabs.onRemoved.addListener((tabId) => {
  pools.delete(tabId)
  void chrome.storage.session.remove(`pool:${tabId}`).catch(() => {})
})

function driver(tabId) {
  let d = drivers.get(tabId)
  if (!d) {
    d = { tabId, queue: [], next: 0, running: false }
    drivers.set(tabId, d)
  }
  return d
}

async function runDriver(d) {
  if (d.running) return
  d.running = true
  try {
    const pool = await poolOf(d.tabId)
    for (;;) {
      const working = () => pool.filter((c) => c.job)
      if (!d.queue.length && !working().length) break
      try {
        await chrome.tabs.get(d.tabId)
      } catch {
        const err = new Error('生成图片用的标签页被关掉了')
        for (const job of [...d.queue, ...working().map((c) => c.job)]) job.reject(err)
        d.queue = []
        pool.length = 0
        break
      }
      // 排队的图先找空着的对话，没有空的且还没开满就开一个新对话；描述先发出去，让网页尽早开始生成
      if (d.queue.length) {
        const limit = Math.max(1, d.queue[0].cmd.concurrency || 3)
        let conv = pool.slice(0, limit).find((c) => !c.job && c.url)
        if (!conv && pool.length < limit) pool.push((conv = { url: '', job: null }))
        if (conv) {
          const job = d.queue.shift()
          conv.job = job
          job.conv = conv
          try {
            await startJob(d, job)
          } catch (e) {
            conv.job = null
            job.reject(e)
          }
          // 新开却没开成的对话不留
          if (!conv.url) pool.splice(pool.indexOf(conv), 1)
          savePool(d.tabId)
          continue
        }
      }
      const list = working()
      const job = list[d.next++ % list.length].job
      let done
      try {
        done = await checkJob(d, job)
      } catch (e) {
        job.reject(e)
        done = true
      }
      if (done) job.conv.job = null
      // 只剩一个对话时它就停在页面上，隔一会儿再看；几个对话时切换本身就要几秒
      if (working().length === 1 && !d.queue.length) await sleep(3000)
    }
  } finally {
    d.running = false
    drivers.delete(d.tabId)
  }
}

/**
 * 让标签页切到某个对话：先让网页自己在页面里切换（不刷新，用户正在看的内容不会被打断），
 * 网页那边切不过去时才改地址重新加载。fresh 表示要开一个新对话
 */
async function openUrl(tabId, url, fresh = false) {
  await ensureContent(tabId)
  const r = await chrome.tabs.sendMessage(tabId, { type: 'nav', url, fresh }).catch(() => null)
  if (r?.ok) return
  const tab = await chrome.tabs.get(tabId)
  if (fresh || tab.url !== url) {
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
  const conv = job.conv
  // 已经开过的对话：切过去接着发。对话被删了、切不过去时改开新对话
  if (conv.url) {
    try {
      await post('progress', { id, text: '在已有的对话里发送描述' })
      await openUrl(d.tabId, conv.url)
      const res = await ask(d.tabId, { type: 'prompt', id, prompt })
      job.base = res.images
      job.replyBase = res.replies
      job.start = Date.now()
      await post('progress', { id, text: '描述已发出，网页正在生成' }).catch(() => {})
      return
    } catch {
      conv.url = ''
    }
  }
  await post('progress', { id, text: '打开新对话' })
  const tab = await chrome.tabs.get(d.tabId)
  await openUrl(d.tabId, newChatUrl(tab.url), true)
  const res = await ask(d.tabId, { type: 'submit', id, prompt })
  conv.url = res.url
  job.base = 0
  job.replyBase = 0
  job.start = Date.now()
  await post('progress', { id, text: '描述已发出，网页正在生成' }).catch(() => {})
}

/** 打开这个对话看一眼：新出现的图马上交给面板；够了几版就结束。返回 true 表示这张图处理完了 */
async function checkJob(d, job) {
  const { id, count, chroma } = job.cmd
  await openUrl(d.tabId, job.conv.url)
  // 对话是接着用的：前面几张图和回复不算这张的
  const res = await ask(d.tabId, { type: 'check', id, skip: job.base + job.got, replyBase: job.replyBase })
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
    job.replyBase = (await ask(d.tabId, { type: 'more', id })).replies
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
