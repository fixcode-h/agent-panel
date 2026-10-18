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
  // 对话方式下输入「/」：内置命令、CLI 自己的命令和 Skill
  await p.goto(base + '#/chat')
  await p.locator('#task-prompt').fill('/')
  await p.locator('#task-prompt').press('End')
  await check(p, '斜杠命令', ['/init', '/commit', 'frontend-design'])
  await p.locator('#task-prompt').fill('')
  // 「+」里引入会话
  await p.getByRole('button', { name: '添加文件、图片或引用' }).click()
  await p.getByRole('button', { name: '引入会话' }).click()
  await check(p, '引入会话', ['主菜单', '购物车右上角'])
  await p.keyboard.press('Escape')
  await p.goto(base)
  await p.getByText('购物车右上角', { exact: false }).first().click()
  await check(p, '任务', ['上下文', '启动命令'])
  await p.goto(base + '#/workflows')
  await check(p, '工作流', ['流程图', '主流程'])
  await p.goto(base + '#/agents')
  await check(p, 'Agent', ['命令预览'])
  await p.goto(base + '#/library')
  await check(p, 'Skills与命令', ['commit-message', 'code-review'])
  await p.getByText('commit-message', { exact: true }).first().click()
  await check(p, 'Skill编辑', ['复制给别的 CLI', '保存'])
  await p.getByRole('button', { name: 'AI 优化' }).click()
  await p.getByPlaceholder('继续说要改的地方').or(p.getByPlaceholder('描述你想要的 Skill')).fill('步骤写得再具体一些')
  await p.keyboard.press('Enter')
  await check(p, 'Skill-AI优化', ['格式校验通过', 'SKILL.md'])
  await p.getByRole('button', { name: '应用修改' }).click()
  await p.keyboard.press('Escape')
  await p.goto(base + '#/mcp')
  await check(p, 'MCP工具', ['github', 'filesystem'])
  await p.getByLabel('编辑').first().click()
  await p.getByRole('button', { name: '测试连接' }).click()
  await check(p, 'MCP编辑', ['连接成功', 'read_file'])
  await p.keyboard.press('Escape')
  await p.goto(base + '#/design/demo-design-menu')
  await check(p, 'UI设计', ['控件树', 'AI 对话', 'StartGroup'])
  // 滚轮在画布上缩放（以鼠标为中心），不滚动整个页面
  const zoomText = async () =>
    Number(
      (
        await p
          .getByText(/^\d+%$/)
          .first()
          .textContent()
      ).replace('%', ''),
    )
  const z0 = await zoomText()
  const cv = await p.locator('[data-wid]').first().boundingBox()
  await p.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2)
  for (let i = 0; i < 3; i++) await p.mouse.wheel(0, -100)
  await p.waitForTimeout(200)
  assert.ok((await zoomText()) > z0, '滚轮往上放大')
  for (let i = 0; i < 3; i++) await p.mouse.wheel(0, 100)
  await p.waitForTimeout(200)
  assert.ok(Math.abs((await zoomText()) - z0) <= 2, '滚轮往下缩回去')
  await p.getByRole('button', { name: '适应窗口' }).click()
  // 控件树右键菜单和二级菜单
  await p.getByRole('treeitem', { name: /StartGroup/ }).click({ button: 'right' })
  await p.getByRole('menuitem', { name: '包裹为' }).hover()
  await check(p, 'UI设计-右键菜单', ['创建副本', 'SizeBox'])
  await p.keyboard.press('Escape')
  await p.keyboard.press('Escape')
  // 动画：选中控件，用预设加一个弹出动画，拖播放头预览
  await p.getByRole('treeitem', { name: /StartGroup/ }).click()
  await p.getByRole('button', { name: /^动画/ }).click()
  await p.getByRole('button', { name: '预设' }).click()
  await p.getByRole('menuitem', { name: '弹出（弹窗）' }).click()
  await check(p, 'UI设计-动画', ['Anim_PopIn', 'StartGroup · 缩放'])
  await p.getByRole('button', { name: '关闭动画面板' }).click()
  // 标注：框选一块，写说明，出现在 AI 输入框上方
  await p.keyboard.press('r')
  const vp = await p.locator('[data-wid]').first().boundingBox()
  await p.mouse.move(vp.x + vp.width * 0.3, vp.y + vp.height * 0.42)
  await p.mouse.down()
  await p.mouse.move(vp.x + vp.width * 0.7, vp.y + vp.height * 0.8, { steps: 6 })
  await p.mouse.up()
  await p.getByRole('textbox', { name: '标注说明' }).fill('按钮换成金色描边，间距大一点')
  await p.keyboard.press('Enter')
  await check(p, 'UI设计-标注', ['按钮换成金色描边'])
  await p.keyboard.press('v')
  // 发给 AI：流式输出，生成图片时进度固定在输入框上方
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).fill('按钮再大一点')
  await p.keyboard.press('Enter')
  // 思考、调设计工具、说明按顺序边出边显示
  await p.getByText(/design · check/).waitFor({ timeout: 15000 })
  await p.waitForTimeout(600)
  await check(p, 'UI设计-写入', ['design · replace_widget'])
  await p.getByText(/正在生成图片 \d+\/\d+/).waitFor({ timeout: 15000 })
  await check(p, 'UI设计-生成中', ['正在生成图片'])
  await p.getByText(/正在生成图片/).waitFor({ state: 'detached', timeout: 20000 })
  await p.getByRole('tab', { name: /图片/ }).click()
  await check(p, 'UI设计-图片')
  // UI 项目设置：美术提示词
  await p.getByText('暗夜远征').first().click({ button: 'right' })
  await p.getByRole('menuitem', { name: '美术提示词' }).click()
  await check(p, 'UI设计-项目提示词', ['让 AI 生成', '画风', '暗黑奇幻'])
  await p.keyboard.press('Escape')
  await p.goto(base + '#/design/new')
  await check(p, 'UI设计-新建', ['开始设计'])
  // 先出原画：新的游戏界面默认打开「原画」，AI 先出几张整屏原画，显示在左边挑
  await p.getByRole('textbox').first().fill('背包')
  await p.getByRole('button', { name: '开始设计' }).click()
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).fill('暗黑奇幻风格的背包界面')
  await p.keyboard.press('Enter')
  await p.getByRole('button', { name: '用这张做模板' }).waitFor({ timeout: 15000 })
  await p.getByText(/正在出原画/).waitFor({ state: 'detached', timeout: 20000 })
  await check(p, 'UI设计-原画', ['第 1 轮', '用这张做模板'])
  await p.getByRole('button', { name: '用这张做模板' }).click()
  await p.getByRole('button', { name: '对照模板' }).waitFor({ timeout: 15000 })
  await p.goto(base + '#/design/new')
  // 网页 UI：新建一个网页设计，让 AI 搭首页，看自动布局画出来的样子
  await p.getByRole('radio', { name: /网页 UI/ }).click()
  await p.getByRole('textbox').first().fill('首页')
  await p.getByRole('button', { name: '开始设计' }).click()
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).fill('做一个产品首页')
  await p.keyboard.press('Enter')
  // 还没定整体风格：AI 先给几个风格选项，点一个接着做
  await p.getByText('想要什么整体风格？').waitFor({ timeout: 15000 })
  // 问题面板换掉输入框：一次问两个问题，最后一项可以自己输入，全部回答后一起发出去
  await check(p, 'UI设计-问风格', ['想要什么整体风格？', '简约科技', '配色'])
  await p.getByRole('button', { name: /简约科技/ }).click()
  await p.getByText('主色调偏向哪种？').waitFor()
  await p.getByRole('textbox', { name: '自己输入回答' }).fill('蓝紫渐变')
  await check(p, 'UI设计-问配色', ['提交 2 个回答'])
  await p.getByRole('button', { name: '提交 2 个回答' }).click()
  await p.getByText('做好了产品首页').first().waitFor({ timeout: 20000 })
  // 回答显示在对话里：问题一行小字，下面是答案
  await check(p, 'UI设计-回答', ['主色调偏向哪种？', '蓝紫渐变'])
  await p.getByText(/正在生成图片/).waitFor({ timeout: 20000 })
  await p.getByText(/正在生成图片/).waitFor({ state: 'detached', timeout: 30000 })
  await check(p, 'UI设计-网页', ['Hero', 'FeatureCard'])
  await p.getByRole('radio', { name: /手机/ }).click()
  await p.waitForTimeout(300)
  await check(p, 'UI设计-网页-手机')
  await p.getByRole('radio', { name: /桌面/ }).click()
  await p.getByRole('button', { name: '版本' }).click()
  await p
    .getByText(/AI 修改前/)
    .first()
    .waitFor()
  await check(p, 'UI设计-版本', ['存版本', 'AI 修改前'])
  await p.keyboard.press('Escape')
  // 侧栏里点设计那一行的图标（不是文字）也能切过去
  const row = await p.getByRole('button', { name: '主菜单', exact: true }).boundingBox()
  await p.mouse.click(row.x - 14, row.y + row.height / 2)
  await p.waitForURL(/demo-design-menu/, { timeout: 5000 })
  await p.getByRole('button', { name: '设置' }).first().click()
  await check(p, '设置', ['常规', '内容宽度'])
  await p.getByRole('button', { name: '风格库' }).click()
  await check(p, '设置-风格库', ['暗黑奇幻'])
  await p.getByRole('button', { name: 'CLI', exact: true }).first().click()
  await p.getByText('添加其他 CLI').scrollIntoViewIfNeeded()
  await check(p, '设置-CLI', ['添加其他 CLI', 'Gemini CLI'])
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
