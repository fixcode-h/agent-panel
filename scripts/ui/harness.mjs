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
import { assertDemoBuildFresh } from '../lib/demo-build-info.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dist = path.join(root, 'dist-demo')
const out = path.join(root, 'ui-shots')

/** 局部截图往外留的空白（px）：足以带上元素边框和阴影，又不会大到跨出视口（下面会夹） */
const CLIP_PAD = 6
/**
 * 截图前等元素出现的上限：元素已经卸载时别用 Playwright 的 30 秒默认超时，
 * 那样整片分片会以 TimeoutError 报废，而这里要的只是「没截到图」
 */
const SHOT_BOX_TIMEOUT_MS = 5000

/** 截图格式和质量：失败诊断看排版和颜色就够了，jpeg 比 png 小一个数量级 */
const SHOT_TYPE = 'jpeg'
const SHOT_QUALITY = 60

/**
 * 每步都截图（SHOTS=all 或总入口的 --verbose）。默认只在失败步骤和分片首尾各拍一张：
 * 全截会让 ui-shots 堆到几十兆、几百张，翻起来也找不到重点。
 */
const SHOTS_ALL = process.env.SHOTS === 'all'

/**
 * 等有限动画播完的兜底上限（ms）。弹出、展开这类过渡普遍在 200ms 内结束，
 * 原来等满 1 秒只是白等；真跑不完的转圈动画本来就不在等待范围内。
 * 比这个时长更长的过渡（例如 duration-500）会被截断，靠它拿「过渡结束态」的分片要自己再等。
 */
const SETTLE_ANIMATION_MS = 300

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
  // 直接跑单个分片时也要拦陈旧产物：总入口虽然已经校验过，这里再算一次很便宜
  assertDemoBuildFresh(root)
  // 分片编号可能是 02、02b、02c 这种（同一个主题拆成几片）：截图文件名要用完整编号，
  // 只取数字会让 02b 和 02 的截图互相覆盖
  const prefix = path.basename(file).match(/^(\d+[a-z]?)-/)?.[1] ?? '00'
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
  // 第几条 check（分片内序号）：截图文件名用它编号，也是「跑过至少一步」的判定
  let stepsRun = 0
  // 上次截图时的 errors 长度：console 错误是异步到达的，可能在这一条 check 之后才 push，
  // 判定不能只看「本条新增的错误」，否则真正出错的那一条反而没截图
  let shotErrors = 0
  // 最后一条 check 用的页面：分片结尾的里程碑截图要在它还活着的时候拍
  let lastPage = null
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
    // 等待上限要当成参数传进去：p.evaluate 的回调在页面里跑，读不到这里的常量
    p.evaluate(async (waitMs) => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
      await frame()
      await frame()
      const finite = document
        .getAnimations()
        .filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      await Promise.race([
        Promise.all(finite.map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, waitMs)),
      ])
      await frame()
    }, SETTLE_ANIMATION_MS)

  /**
   * 拍某个元素的特写（只截它周围的区域）：全页截图里右下角的浮条只有一小块，看不出细节。
   * clip 必须夹进视口——元素贴着窗口边缘时（浮条夹回视口只留 EDGE=8px），
   * 直接按「矩形 + 留白」算会跨出页面，Playwright 的 screenshot 会抛错、整个分片报废，而不是这条断言失败。
   */
  async function shotOf(p, loc, name) {
    // 元素已经不在了（例如过渡面板已淡出卸载）时 boundingBox 会等默认 30 秒再抛错，整个分片报废；
    // 这里只当「没截到图」返回 false，交给调用方报一条具体断言，别把分片拖进 TimeoutError
    const box = await loc.boundingBox({ timeout: SHOT_BOX_TIMEOUT_MS }).catch(() => null)
    if (!box) return false
    const view = await p.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    // 起点也夹上界：元素整个落在视口右侧/下方外时，光给宽高兜下界不够（x 已经大于视口宽，x+1 仍越界）
    const x = Math.min(Math.max(0, box.x - CLIP_PAD), Math.max(0, view.w - 1))
    const y = Math.min(Math.max(0, box.y - CLIP_PAD), Math.max(0, view.h - 1))
    await shot(p, `${prefix}-${name}`, {
      x,
      y,
      // 宽高再兜一层下界：元素整个落在视口外时 `view.w - x` 会 <= 0，
      // clip 非正会让 screenshot 报错、把整个分片搞挂（跟 clip 越界是同一类问题）
      width: Math.max(1, Math.min(view.w - x, box.width + CLIP_PAD * 2)),
      height: Math.max(1, Math.min(view.h - y, box.height + CLIP_PAD * 2)),
    })
    return true
  }

  /** 截图落到 ui-shots/：格式和质量统一走上面的常量，不再各写一份 */
  const shot = (p, name, clip) =>
    p.screenshot({
      path: path.join(out, `${name}.${SHOT_TYPE === 'jpeg' ? 'jpg' : SHOT_TYPE}`),
      type: SHOT_TYPE,
      quality: SHOT_QUALITY,
      ...(clip ? { clip } : {}),
    })

  async function check(p, name, expect = []) {
    for (const text of expect)
      // 只认看得见的那一个：父对话和中间的子对话页签都挂着，藏起来的那边可能有同样的文字
      await p
        .getByText(text, { exact: false })
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push(`${name}：没有显示「${text}」`))
    await settle(p).catch(() => {})
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (overflow > 1) errors.push(`${name}：出现横向滚动（多出 ${overflow}px）`)
    const seq = ++stepsRun
    lastPage = p
    // 默认只拍第一步（分片开头）和出错的步骤：
    // 看的是「自上次截图以来有没有新增错误」，迟到的 console 错误由下一次 check 补拍
    if (SHOTS_ALL || seq === 1 || errors.length > shotErrors) {
      await shot(p, `${prefix}-${String(seq).padStart(2, '0')}-${name}`).catch(() => {})
      shotErrors = errors.length
    }
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
    await fn({ base, page, check, errors, settle, shotOf })
    // 分片结尾的里程碑：最后一条 check 的页面上再拍一张全页，和开头那张凑成一头一尾
    if (lastPage) await shot(lastPage, `${prefix}-zz-结束`).catch(() => {})
  } catch (e) {
    failed = true
    // CI 里看不到截图时，至少在检查结果的注释里能看到是哪一步、为什么失败
    if (process.env.GITHUB_ACTIONS)
      console.log(
        `::error title=界面检查::${prefix} 第 ${stepsRun} 步之后出错：${String(e?.message ?? e)
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
  if (failed || stepsRun === 0) process.exit(1)
  process.exit(0)
}

/**
 * 预期底部留白（像素）：从 dialogScrollClass 的 pb-N 换算，不在脚本里再写一份数字。
 * 改 web/src/components/ui/dialog.tsx 的留白时断言跟着走，失败信息也不会把人往「改断言」引。
 */
export function dialogBottomSpacePx() {
  const src = readFileSync(path.join(root, 'web/src/components/ui/dialog.tsx'), 'utf8')
  const found = src.match(/dialogScrollClass\s*=\s*'[^'\n]*?\bpb-(\d+)/)
  if (!found) throw new Error('读不到 dialogScrollClass 的底部留白（web/src/components/ui/dialog.tsx）')
  return Number(found[1]) * 4 // Tailwind 的 pb-12 = 12 × 0.25rem = 48px
}

/**
 * 弹窗内容滚动区滚到底后的底部留白：返回 { pad, gap } 或 { error }。
 * 结构是 header（shrink-0）+ 内容滚动区 + footer（shrink-0，取消 / 确认），
 * 滚动区底边紧贴 footer 顶边，所以滚到底时 footer.top - 最后一块底边 ≈ padding-bottom。
 */
export async function measureDialogBottomSpace(p) {
  return p.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const footer = dialog?.querySelector('footer')
    if (!footer) return { error: '没有底部操作栏' }
    // 滚动区：弹窗里能滚的那一块（分页设置里常规页是 form，其他页是 div），取可视高度最大的
    const body = [...dialog.querySelectorAll('form, div')]
      .filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.clientHeight > 0)
      .sort((a, b) => b.clientHeight - a.clientHeight)[0]
    if (!body) return { error: '没有滚动内容区' }
    // 先滚到底：底部留白要在内容末尾和操作栏之间量
    body.scrollTop = body.scrollHeight
    // 最后一块：滚动区的直接子元素（内层小滚动区里被裁掉的元素不算）
    const blocks = [...body.children].map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0)
    if (!blocks.length) return { error: '内容区是空的' }
    const lastBottom = Math.max(...blocks.map((r) => r.bottom))
    return {
      pad: parseFloat(getComputedStyle(body).paddingBottom),
      gap: footer.getBoundingClientRect().top - lastBottom,
    }
  })
}

/** 弹窗滚到底的底部留白是否统一：返回问题描述，空数组表示通过 */
export async function dialogBottomSpaceProblems(p, label) {
  const expected = dialogBottomSpacePx()
  const info = await measureDialogBottomSpace(p)
  if (info.error) return [`${label}：${info.error}`]
  const problems = []
  if (Math.abs(info.pad - expected) > 0.5) problems.push(`${label}：底部留白 ${info.pad}px，应为 ${expected}px`)
  if (info.gap < expected - 0.5) problems.push(`${label}：最后一块距底部操作栏 ${info.gap}px，应至少 ${expected}px`)
  return problems
}
