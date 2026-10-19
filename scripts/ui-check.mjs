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
  // 工作流任务：任务进度是主 Agent → 节点 → 子 Agent 的层级
  await p.getByText('商品详情页增加', { exact: false }).first().click()
  await check(p, '任务-主Agent调度', ['主 Agent', '调度', '子 Agent · 单元测试'])
  await p.goto(base + '#/workflows')
  await check(p, '工作流', ['流程图', '主流程'])
  // 内置工作流：添加后连同 Agent 一起建好，直接打开
  await p.getByRole('button', { name: '添加内置或导入的工作流' }).click()
  await p.getByRole('menuitem', { name: '从内置工作流添加' }).click()
  await check(p, '内置工作流', ['日常开发', '功能开发（OpenSpec）', 'Blender 建模与动画'])
  await p.getByRole('button', { name: '添加', exact: true }).first().click()
  // 要建好几个 Agent，演示里每个请求都有模拟的延迟，等弹窗关掉
  await p.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20000 })
  await check(p, '内置工作流-添加后', ['识别现场与设计', '文档与提交'])
  // 「默认」工作流：什么都能交给它，做完推荐已有的工作流，点一下就带着上下文执行
  await p.goto(base)
  await p.getByTitle('执行的工作流').click()
  await p.getByRole('dialog').getByText('默认', { exact: true }).click()
  await p.locator('#task-prompt').fill('分析一下这个项目的结构')
  await p.locator('#task-prompt').press('Enter')
  await p.getByText('推荐的下一步').waitFor({ timeout: 20000 })
  await check(p, '默认工作流-推荐', ['推荐的下一步', '执行'])
  const doneTask = p.url()
  await p.getByRole('region', { name: '推荐的下一步' }).getByRole('button').first().click()
  await check(p, '默认工作流-执行推荐', ['之前的上下文'])
  // AI 分析执行结果：新建分析对话，给出修改建议的差异和框架问题，勾选后应用到工作流
  await p.goto(doneTask)
  await p.getByRole('button', { name: '更多操作' }).click()
  await p.getByRole('menuitem', { name: 'AI 分析执行结果' }).click()
  await p.getByRole('dialog').getByRole('button', { name: '开始分析' }).click()
  await p.getByText('工作流优化建议').waitFor({ timeout: 20000 })
  await p.getByRole('button', { name: '看差异' }).first().click()
  await check(p, 'AI分析-建议', ['工作流优化建议', '面板框架的问题', '先确认范围'])
  await p.getByRole('button', { name: /应用选中的 2 项/ }).click()
  await check(p, 'AI分析-已应用', ['已应用'])
  // 工作流停下后没走完：输入框上面一行「继续流程」，旁边的关闭是结束流程
  await p.goto(base)
  await p.locator('#task-prompt').fill('给登录页加一个记住我')
  // 刚打开时数据还在加载，等输入框下面的选项出来再发
  await p.waitForTimeout(300)
  await p.locator('#task-prompt').press('Enter')
  await p.getByRole('button', { name: '停止', exact: true }).first().click({ timeout: 20000 })
  await p.getByRole('button', { name: '继续流程' }).waitFor({ timeout: 20000 })
  await check(p, '流程没走完', ['继续流程', '流程没有完成'])
  await p.goto(base + '#/agents')
  await check(p, 'Agent', ['命令预览'])
  // 内置 Agent：手动添加，已经随工作流建好的标成已添加
  await p.getByRole('button', { name: '添加内置 Agent' }).first().click()
  await check(p, '内置Agent', ['通用约束', 'UE 侦察', '代码侦察', '已添加'])
  await p.keyboard.press('Escape')
  // Agent 的引入层级和参数的选项编辑（带序号的卡片、回车添加）
  await p.getByText('开发者', { exact: true }).first().click()
  await p.getByRole('button', { name: /\{\{vcs\}\}/ }).click()
  await p.getByRole('textbox', { name: '新选项' }).fill('svn')
  await p.getByRole('textbox', { name: '新选项' }).press('Enter')
  await p.getByRole('button', { name: '删除选项「svn」' }).scrollIntoViewIfNeeded()
  await check(p, 'Agent-参数选项', ['通用约束', 'svn'])
  await p.goto(base + '#/library')
  await check(p, 'Skills与命令', ['commit-message', 'code-review'])
  await p.getByRole('radio', { name: '自带 Skill' }).click()
  await check(p, '自带Skill', ['brainstorming', 'blender', '版本控制'])
  await p.getByRole('radio', { name: 'Skill', exact: true }).click()
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
  // 动画面板默认打开
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
  // 把图片拖到画布上：能放、大小合适的控件高亮，松手就用上（用脚本发拖放事件，无头浏览器的鼠标拖不出 HTML5 拖放）
  await p.evaluate(() => {
    window.__dt = new DataTransfer()
    const thumb = document.querySelector('button[draggable="true"]')
    thumb.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }))
  })
  await p.waitForTimeout(200)
  const dragAt = (type) =>
    p.evaluate((type) => {
      const slot = document.querySelector('[data-drop-slot]')
      if (!slot) return ''
      const r = slot.getBoundingClientRect()
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__dt }
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      document.elementFromPoint(x, y).dispatchEvent(new DragEvent(type, { ...at, clientX: x, clientY: y }))
      return slot.dataset.dropSlot
    }, type)
  const dropName = await dragAt('dragover')
  assert.ok(dropName, '拖图片时有大小合适的控件高亮')
  await check(p, 'UI设计-拖图片', ['放到 ' + dropName])
  await dragAt('drop')
  await p.evaluate(() =>
    document
      .querySelector('button[draggable="true"]')
      .dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt })),
  )
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
  await p.getByRole('button', { name: '字体', exact: true }).click()
  await check(p, '设置-字体', ['Maple Mono NL', '字间距', '空格宽度'])
  await p.getByRole('button', { name: '风格库' }).click()
  await check(p, '设置-风格库', ['暗黑奇幻'])
  await p.getByRole('button', { name: 'CLI', exact: true }).first().click()
  await p.getByText('添加其他 CLI').scrollIntoViewIfNeeded()
  await check(p, '设置-CLI', ['添加其他 CLI', 'Gemini CLI'])
  // 三档模型的上下文、最大输出：默认按模型自动填，手动改了能恢复自动；Codex 不接受最大输出
  await p.getByRole('dialog').getByText('Claude Code', { exact: true }).first().click()
  const ctx = p.getByRole('dialog').getByLabel('上下文', { exact: true }).first()
  await ctx.scrollIntoViewIfNeeded()
  await ctx.fill('500k')
  await ctx.press('Enter')
  await check(p, '设置-CLI-三档上下文', ['三档模型'])
  if (!(await p.getByRole('dialog').getByPlaceholder('自动 · 128K').count()))
    errors.push('设置-CLI-三档上下文：最大输出没有按模型自动填')
  if ((await ctx.inputValue()) !== '500K')
    errors.push(`设置-CLI-三档上下文：手填的值显示成了「${await ctx.inputValue()}」`)
  await p.getByRole('dialog').getByRole('button', { name: '恢复自动' }).first().click()
  if ((await ctx.inputValue()) !== '') errors.push('设置-CLI-三档上下文：恢复自动后没有清空')
  await p.getByRole('dialog').getByText('Codex', { exact: true }).first().click()
  await p.getByText('没有设置最大输出的参数').first().scrollIntoViewIfNeeded()
  await check(p, '设置-CLI-Codex档位', ['没有设置最大输出的参数'])
  // 报错的地方都有「AI 处理」：演示里 Pi 卸载会失败（留着启动脚本），点了在统一的弹窗里看 AI 的处理
  await p.getByRole('dialog').getByText('Pi', { exact: true }).first().click()
  await p.getByRole('button', { name: '安装', exact: true }).first().click()
  await p.getByText('安装完成').first().waitFor({ timeout: 8000 })
  await p.getByRole('button', { name: '卸载', exact: true }).first().click()
  await p.getByRole('dialog').last().getByRole('button', { name: '卸载', exact: true }).click()
  await p.getByText('卸载没有成功').first().waitFor({ timeout: 8000 })
  await check(p, '设置-CLI-卸载失败', ['卸载没有成功', 'AI 处理'])
  await p.getByRole('button', { name: 'AI 处理', exact: true }).first().click()
  // 在聊天里新建一个排查对话，显示在大窗口里；最小化成右下角的按钮，排查照常进行
  await p
    .getByRole('heading', { name: 'AI 排查：Pi：卸载没有成功' })
    .last()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('AI 处理：没有新建排查对话'))
  await check(p, 'AI处理-对话', ['出了什么问题：Pi：卸载没有成功'])
  await p.getByRole('button', { name: '最小化', exact: true }).last().click()
  await check(p, 'AI处理-最小化', ['AI 排查：Pi：卸载没有成功'])
  await p.getByRole('button', { name: /^AI 排查：Pi/ }).click()
  // 关闭：还在排查时先提醒会停止
  await p.getByRole('button', { name: '关闭', exact: true }).last().click()
  if (await p.getByText('停止 AI 排查？').isVisible()) {
    await check(p, 'AI处理-关闭提醒', ['以后不再提醒，关闭时直接停止'])
    await p.getByRole('button', { name: '停止并关闭' }).click()
  }
  // API 配置：识别到各个 CLI 自己配的 API，确认后存进列表
  await p.getByRole('button', { name: 'API 配置', exact: true }).first().click()
  await check(p, '设置-API-识别', ['在本机 CLI 的配置里识别到 2 个 API', 'Codex · openrouter'])
  await p.getByRole('button', { name: '存到 API 配置' }).first().click()
  await check(p, '设置-API-已存', ['已在列表中'])
  // 回到 CLI 的默认 CLI 页（部署在它下面）
  await p.getByRole('button', { name: 'CLI', exact: true }).first().click()
  await p.getByRole('dialog').getByText('默认 CLI', { exact: true }).first().click()
  // 部署：全局说明写进各 CLI，技能默认不选，选了再部署
  await p.getByRole('button', { name: '部署', exact: true }).first().click()
  await check(p, '设置-部署', ['全局说明（AGENTS.md）', '写到哪些 CLI', '要部署的技能', 'grilling'])
  await p.getByRole('switch', { name: 'grilling' }).click()
  await p.getByRole('button', { name: '部署', exact: true }).last().click()
  await p
    .getByText('部署好了')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('部署：没有提示部署结果'))
  await check(p, '设置-部署-完成', ['已部署', '已是最新'])
  // 本机生图：一键安装 ComfyUI、下载推荐的模型（演示里是模拟的进度）
  await p.getByRole('button', { name: '本机生图' }).click()
  await check(p, '设置-本机生图', ['一键安装', 'Z-Image Turbo', '建议显存'])
  await p.getByRole('button', { name: '一键安装' }).click()
  await p.getByText('已安装，未启动').waitFor({ timeout: 10000 })
  await p.getByRole('button', { name: '下载' }).first().click()
  await p.getByText('Z-Image Turbo 已下载').or(p.getByText('已下载').first()).waitFor({ timeout: 10000 })
  await check(p, '设置-本机生图-已下载', ['已下载'])
  await p.keyboard.press('Escape')
  // ComfyUI 工作流：游戏和网页分开，内置的只读
  await p.goto(base + '#/comfy/game')
  await check(p, 'ComfyUI-工作流', ['游戏图标 · 道具与技能', '内置，只读', '{{prompt}}', 'KSampler'])
  // 节点图可以在图形和配置（JSON）之间切换
  await p.getByRole('radio', { name: '配置', exact: true }).click()
  await check(p, 'ComfyUI-节点图配置', ['"class_type"'])
  await p.getByRole('radio', { name: '图形', exact: true }).click()
  // 在 ComfyUI 页点 Agent 模式要能切回去（之前会停在 ComfyUI）
  await p.getByRole('radio', { name: /^Agent 模式/ }).click()
  await p
    .waitForURL((u) => !u.hash.startsWith('#/comfy'), { timeout: 5000 })
    .catch(() => errors.push('在 ComfyUI 页点 Agent 模式没有切过去'))
  await p.goto(base + '#/comfy/game')
  await p.getByRole('radio', { name: '网页 UI' }).click()
  await check(p, 'ComfyUI-网页工作流', ['网页插画'])
  await p.getByRole('button', { name: 'AI 优化' }).click()
  await p.getByRole('button', { name: '出图更清晰、边缘更干净' }).click()
  await p.getByRole('button', { name: '优化', exact: true }).click()
  await check(p, 'ComfyUI-AI优化', ['网页插画（优化）', '保存'])
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
