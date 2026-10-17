#!/usr/bin/env node
/**
 * 界面检查：用浏览器打开在线演示版（不需要后端），走一遍常用页面，截图存到 ui-shots/。
 * 检查页面没有报错、关键内容都显示出来、宽屏和手机宽度都没有横向滚动条。
 * 截图在 CI 里作为附件上传，改了界面可以下载下来对比。
 *
 * 用法：npx vite build --mode demo && node scripts/ui-check.mjs
 */
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'dist-demo')
const out = path.join(root, 'ui-shots')
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('先运行 npx vite build --mode demo')
  process.exit(1)
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const file = path.join(dist, p === '/' ? 'index.html' : p)
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.statusCode = 404
    return res.end()
  }
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`

// 本机有现成的浏览器时直接用（CI 里由 playwright install 装好）
const exe = process.env.CHROMIUM_PATH
const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const errors = []
let n = 0

async function page(viewport) {
  const p = await browser.newPage({ viewport, locale: 'zh-CN' })
  p.on('pageerror', (e) => errors.push(`页面出错：${e.message}`))
  p.on('console', (m) => {
    if (m.type() !== 'error') return
    // 外部资源（GitHub 的版本列表、字体）加载失败和页面本身无关：CI 的机器共用 IP，GitHub 接口常被限流返回 403
    if (/^Failed to load resource/.test(m.text()) && !m.location().url.startsWith(base)) return
    errors.push(`控制台错误：${m.text()}`)
  })
  return p
}

async function check(p, name, expect = []) {
  await p.waitForTimeout(600)
  for (const text of expect)
    await p
      .getByText(text, { exact: false })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push(`${name}：没有显示「${text}」`))
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (overflow > 1) errors.push(`${name}：出现横向滚动（多出 ${overflow}px）`)
  await p.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${name}.png`) })
  console.log(`✓ ${name}`)
}

try {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await check(p, '首页', ['新建任务', '工作流'])
  await p.getByText('购物车右上角', { exact: false }).first().click()
  await check(p, '任务', ['上下文', '启动命令'])
  await p.goto(base + '#/workflows')
  await check(p, '工作流', ['流程图', '主流程'])
  await p.goto(base + '#/agents')
  await check(p, 'Agent', ['命令预览'])
  await p.goto(base + '#/design/demo-design-menu')
  await check(p, 'UI设计', ['控件树', 'AI 对话', 'StartGroup'])
  await p.getByRole('tab', { name: /图片/ }).click()
  await check(p, 'UI设计-图片')
  await p.goto(base + '#/design/new')
  await check(p, 'UI设计-新建', ['开始设计'])
  await p.getByRole('button', { name: '设置' }).first().click()
  await check(p, '设置', ['常规', '内容宽度'])
  await p.keyboard.press('Escape')
  await p.keyboard.press('Control+k')
  await check(p, '命令面板', ['新建聊天'])
  await p.keyboard.press('Escape')
  // 浅色主题
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
  await p.goto(base + '#/projects')
  await check(p, '项目-浅色')

  const m = await page({ width: 390, height: 844 })
  await m.goto(base)
  await check(m, '手机-首页', ['今天要做什么'])
  await m.goto(base + '#/workflows')
  await check(m, '手机-工作流')
} finally {
  await browser.close()
  server.close()
}

if (errors.length) {
  console.error('\n' + errors.join('\n'))
  process.exit(1)
}
console.log(`\n界面检查通过，截图在 ui-shots/`)
assert.ok(n > 0)
