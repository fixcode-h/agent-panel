/**
 * 界面检查的共享环境：每个分片（scripts/ui/*.mjs）自己调一次 runShard()，
 * 各自起静态服务、开浏览器，页面各用自己的浏览器上下文（演示数据存在 localStorage 里，互不影响），可以并行跑。
 *
 * 这里负责：静态服务、浏览器、开页面（收集页面报错和控制台错误）、check() 截图和计时、
 * 失败时的输出和收尾。截图存到 ui-shots/，文件名带分片编号，改界面时可以下载对比。
 */
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dist = path.join(root, 'dist-demo')
const out = path.join(root, 'ui-shots')

// 一张 1×1 的 PNG：贴图、图片气泡的检查都用它
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// 演示里模拟的等待（请求延迟、流式输出、安装进度）按这个倍数缩短，见 web/src/lib/demo-speed.ts。
// 不缩到 0：「生成中」「授权中」这些中间状态也要截图，太快就看不到了
const DEMO_SPEED = process.env.AGENT_PANEL_UI_DEMO_SPEED ?? '4'

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

/**
 * 跑一个分片：fn(api) 里写这个分片的检查。
 * 文件名前缀（01、02…）用作截图的前缀，同一分片里的截图按顺序编号。
 */
export async function runShard(file, fn) {
  if (!existsSync(path.join(dist, 'index.html'))) {
    console.error('先运行 npx vite build --mode demo')
    process.exit(1)
  }
  const prefix = path.basename(file).match(/^(\d+)-/)?.[1] ?? '00'
  mkdirSync(out, { recursive: true })

  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const f = path.join(dist, p === '/' ? 'index.html' : p)
    if (!f.startsWith(dist) || !existsSync(f)) {
      res.statusCode = 404
      return res.end()
    }
    res.setHeader('content-type', TYPES[path.extname(f)] ?? 'application/octet-stream')
    res.end(readFileSync(f))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/`

  // 本机有现成的浏览器时直接用（CI 里由 playwright install 装好）
  const exe = process.env.CHROMIUM_PATH
  const browser = await chromium.launch(exe ? { executablePath: exe } : {})
  const errors = []
  const steps = []
  let n = 0
  let last = Date.now()
  const startedAt = last

  async function page(viewport) {
    // 复制图片、复制对话要往系统剪贴板里写，验证时还要读回来对一下
    const ctx = await browser.newContext({
      viewport,
      locale: 'zh-CN',
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    await ctx.addInitScript((speed) => {
      try {
        localStorage.setItem('agent-panel-demo-speed', speed)
      } catch {}
    }, DEMO_SPEED)
    const p = await ctx.newPage()
    p.on('pageerror', (e) => errors.push(`页面出错：${e.message}`))
    p.on('console', (m) => {
      if (m.type() !== 'error') return
      // 外部资源（GitHub 的版本列表、字体）加载失败和页面本身无关：CI 的机器共用 IP，GitHub 接口常被限流返回 403
      if (/^Failed to load resource/.test(m.text()) && !m.location().url.startsWith(base)) return
      errors.push(`控制台错误：${m.text()}`)
    })
    return p
  }

  /** 等页面静下来：两帧渲染完，并且一次性的动画（弹出、展开）都播完；转圈这类无限循环的动画不等 */
  const settle = (p) =>
    p.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
      await frame()
      await frame()
      const finite = document
        .getAnimations()
        .filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      await Promise.race([
        Promise.all(finite.map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, 1000)),
      ])
      await frame()
    })

  async function check(p, name, expect = []) {
    for (const text of expect)
      await p
        .getByText(text, { exact: false })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push(`${name}：没有显示「${text}」`))
    await settle(p).catch(() => {})
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (overflow > 1) errors.push(`${name}：出现横向滚动（多出 ${overflow}px）`)
    await p.screenshot({ path: path.join(out, `${prefix}-${String(++n).padStart(2, '0')}-${name}.png`) })
    const now = Date.now()
    steps.push({ name, ms: now - last })
    last = now
    console.log(`✓ ${name}`)
  }

  const writeTimings = () => {
    const f = process.env.AGENT_PANEL_UI_TIMINGS
    if (!f) return
    try {
      writeFileSync(f, JSON.stringify({ total: Date.now() - startedAt, steps }))
    } catch {}
  }

  let failed = false
  try {
    await fn({ base, page, check, errors, settle })
  } catch (e) {
    failed = true
    // CI 里看不到截图时，至少在检查结果的注释里能看到是哪一步、为什么失败
    if (process.env.GITHUB_ACTIONS)
      console.log(
        `::error title=界面检查::${prefix} 第 ${n} 步之后出错：${String(e?.message ?? e)
          .split('\n')
          .filter((l) => l.trim() && !/^Call log/.test(l))
          .slice(0, 2)
          .join(' ')
          .replace(/\x1b\[[0-9;]*m/g, '')}`,
      )
    console.error(e)
  } finally {
    writeTimings()
    await browser.close().catch(() => {})
    server.closeAllConnections()
    server.close()
  }

  if (errors.length) {
    if (process.env.GITHUB_ACTIONS) for (const e of errors) console.log(`::error title=界面检查::${e.split('\n')[0]}`)
    console.error('\n' + errors.join('\n'))
    process.exit(1)
  }
  if (failed || n === 0) process.exit(1)
  process.exit(0)
}
