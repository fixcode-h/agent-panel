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
  // 复制图片、复制对话要往系统剪贴板里写，验证时还要读回来对一下
  const ctx = await browser.newContext({
    viewport,
    locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
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

// 一张 1×1 的 PNG：贴图、图片气泡的检查都用它
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

try {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await check(p, '首页', ['新建任务', '工作流'])
  // 左侧栏不再有独立的「文件」入口：文件的入口只在项目页右侧的文件面板里
  if (
    await p
      .locator('nav[aria-label="主导航"] button')
      .filter({ hasText: /^文件$/ })
      .count()
  )
    errors.push('侧栏：还留着「文件」这个入口')
  // 对话方式下输入「/」：内置命令、CLI 自己的命令和 Skill
  await p.goto(base + '#/chat')
  await p.locator('#task-prompt').fill('/')
  await p.locator('#task-prompt').press('End')
  await check(p, '斜杠命令', ['/init', '/commit', 'frontend-design'])
  // 选中后是文字原位的一张卡片；光标停在它后面，按一次退格整张删掉
  await p.locator('#task-prompt').fill('前 ')
  await p.locator('#task-prompt').pressSequentially('/frontend-design')
  await p.getByRole('listbox').getByText('/frontend-design', { exact: true }).click()
  const skillChip = p.locator('#task-prompt [data-chip="skill"]')
  await skillChip.waitFor({ timeout: 5000 }).catch(() => errors.push('行内技能卡片：选中后没有出现在文字里'))
  await check(p, '斜杠命令-行内技能', ['前', '/frontend-design'])
  await p.keyboard.press('Backspace')
  await skillChip
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('行内技能卡片：按一次退格没有整张删掉'))
  await p.locator('#task-prompt').fill('')
  // 图片是文字原位的一张图：直接显示图片本身，点开看大图，右上角有删除按钮
  await p
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: '截图.png', mimeType: 'image/png', buffer: TINY_PNG })
  const imageChip = p.locator('#task-prompt [data-chip="image"]')
  await imageChip.waitFor({ timeout: 10000 }).catch(() => errors.push('行内图片卡片：附上图片后没有出现在文字里'))
  if (!(await imageChip.locator('img[src^="blob:"]').count())) errors.push('行内图片卡片：没有显示缩略图')
  // 输入框上方不再有附件条
  if (await p.getByRole('button', { name: '移除 截图.png' }).count()) errors.push('输入框上方还有附件条')
  // 右键卡片弹出面板自己的菜单（不是浏览器原生菜单），点「复制图片」真的写进系统剪贴板
  await imageChip.click({ button: 'right' })
  const copyImageItem = p.getByRole('menuitem', { name: '复制图片' })
  await copyImageItem.waitFor({ timeout: 3000 }).catch(() => errors.push('行内图片卡片：右键没有弹出卡片菜单'))
  await check(p, '输入框卡片-右键菜单', ['复制图片'])
  await copyImageItem.click()
  await p
    .getByText('图片已复制到剪贴板')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('行内图片卡片：复制图片后没有成功提示'))
  const clipTypes = await p
    .evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types))
    .catch(() => null)
  if (!clipTypes) errors.push('行内图片卡片：读不到剪贴板（权限或浏览器不支持）')
  else if (!clipTypes.includes('image/png'))
    errors.push(`行内图片卡片：剪贴板里没有 PNG（${clipTypes.join(',') || '空'}）`)
  // 点图片能看大图
  await imageChip.locator('img').click()
  await p
    .getByRole('dialog')
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('行内图片卡片：点图片没有打开大图'))
  await p.keyboard.press('Escape')
  // 卡片右上角的删除按钮能删掉这张卡片
  await imageChip.locator('[data-chip-action="remove"]').click()
  await imageChip
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('行内图片卡片：点卡片上的删除后卡片还在'))
  // 「+」里引入会话
  await p.getByRole('button', { name: '添加文件、图片或引用' }).click()
  await p.getByRole('button', { name: '引入会话' }).click()
  await check(p, '引入会话', ['主菜单', '购物车右上角'])
  await p.keyboard.press('Escape')
  await p.goto(base)
  await p.getByText('购物车右上角', { exact: false }).first().click()
  // 右栏是文件系统（带 git 状态），启动命令是名字那行最右边的图标，上下文和用量在输入框下面
  await check(p, '任务', ['src', '命中', 'package.json'])
  // 实时推送时输入框不能被重新挂载、不能丢焦点：演示任务改成执行中，打字期间会不停推快照
  // （一次推送整页重渲染时，输入框如果跟着重挂载或重画，用户打一半就会失焦、字也会跳）
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    const openTask = async () => {
      await p.reload()
      await p.waitForTimeout(400)
      if (!(await p.getByTitle('Token 用量').count())) {
        await p.getByText('购物车右上角', { exact: false }).first().click()
        await p.waitForTimeout(600)
      }
    }
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const task = db.tasks.find((x) => x.title.includes('购物车'))
      task.status = 'running'
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    await openTask()
    const before = await p.evaluate(() => {
      window.__composer = document.querySelector('#follow-up')
      return { id: window.__composer?.id ?? '' }
    })
    await p.locator('#follow-up').click()
    await p.keyboard.type('实时推送时输入的内容')
    await p.waitForTimeout(1600)
    const after = await p.evaluate(() => {
      const el = document.querySelector('#follow-up')
      return {
        same: el === window.__composer,
        focused: el === document.activeElement,
        active: document.activeElement?.id ?? document.activeElement?.tagName ?? '',
        text: el?.textContent ?? '',
      }
    })
    if (before.id !== 'follow-up') errors.push('任务页没有找到输入框')
    else {
      if (!after.same) errors.push('实时推送时输入框被重新挂载')
      if (!after.focused) errors.push(`实时推送时输入框丢了焦点（焦点在 ${after.active}）`)
      if (!after.text.includes('实时推送时输入的内容')) errors.push('实时推送时输入的文字丢了')
    }
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await openTask()
  }
  // Token 胶囊：点开浮层看整个运行的合计（本对话 + 子对话 + 派出的子任务）
  {
    await p.getByTitle('Token 用量').first().click()
    await check(p, '任务-Token浮层', ['整个运行', '缓存命中'])
    await p.keyboard.press('Escape')
  }
  // 浮层里的速度只算正在输出的：造两种数据各截一张（演示数据用完改回去，不影响后面的截图）
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    /** writing：父对话在写、子对话和子任务都停了（留着上一轮很高的速度）；idle：全都没在输出 */
    const setup = (mode) =>
      p.evaluate(
        ([k, m]) => {
          const db = JSON.parse(localStorage.getItem(k))
          const parent = db.tasks.find((x) => x.title.includes('购物车'))
          const agent = (tps, lastTps) => ({
            context: 96000,
            window: 200000,
            model: 'claude-sonnet-5-5',
            tps,
            lastTps,
            outputTokens: 1000,
            genMs: 1000,
          })
          // 自己的步骤和派出的子任务分开用两个角色，界面才能把两层的速度拆开
          for (const s of parent.steps) s.agentId = s.slot === 'sub' ? 'demo-helper' : 'demo-own'
          parent.status = m === 'writing' ? 'running' : 'done'
          parent.usage.agents = {
            'demo-own': agent(m === 'writing' ? 42 : 0, m === 'writing' ? 42 : 900),
            // 已经停下的子任务：lastTps 还留着 2041.7，不能算进速度
            'demo-helper': agent(0, 2041.7),
          }
          db.tasks = db.tasks.filter((x) => !x.id.startsWith('demo-speed-'))
          for (const [i, id] of ['demo-speed-c1', 'demo-speed-c2'].entries()) {
            db.tasks.push({
              ...structuredClone(parent),
              id,
              parentTaskId: i ? 'demo-speed-c1' : parent.id,
              rootTaskId: parent.id,
              title: i ? '子对话：核对通知时序' : '子对话：角标订阅',
              status: 'done',
              steps: [],
              messages: [],
              usage: {
                agents: { 'demo-child': agent(0, 3000) },
                inputTokens: 2000,
                outputTokens: 200,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0.01,
              },
            })
          }
          localStorage.setItem(k, JSON.stringify(db))
        },
        [key, mode],
      )
    // 重新加载后回到任务页（当前路由就是任务页，不用再点头部）
    const gotoTask = async () => {
      await p.reload()
      await p.waitForTimeout(500)
      if (!(await p.getByTitle('Token 用量').count())) {
        await p.getByText('购物车右上角', { exact: false }).first().click()
        await p.waitForTimeout(600)
      }
    }
    const openToken = async () => {
      await gotoTask()
      await p.getByTitle('Token 用量').first().click()
      await p.waitForTimeout(500)
    }
    const popover = async () => (await p.getByRole('dialog').last().innerText()).replace(/\s+/g, ' ')
    // 父对话在写：整体 = 本对话，子任务与子对话那行是「空闲」
    await setup('writing')
    await openToken()
    await check(p, '任务-Token浮层-父对话在写', ['整个运行', '空闲', '42.0 token/s'])
    const writing = await popover()
    if (/2041\.7|3000\.0/.test(writing)) errors.push(`Token 浮层：停下的子任务还在贡献速度（${writing}）`)
    await p.keyboard.press('Escape')
    // 全都没在输出：不显示任何残留速度
    await setup('idle')
    await openToken()
    await check(p, '任务-Token浮层-全都空闲', ['整个运行', '空闲'])
    const idle = await popover()
    if (/token\/s/.test(idle)) errors.push(`Token 浮层：全都空闲时还显示速度（${idle}）`)
    await p.keyboard.press('Escape')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await gotoTask()
  }
  // 执行计划：输入框上方的按钮，点开是计划窗口（进行中的主步骤展开子步骤），以前的计划收在下面
  await p.getByRole('button', { name: '执行计划' }).click()
  await check(p, '执行计划', ['修复购物车角标', '等：端到端测试', '覆盖删除商品后角标归零', '以前的计划 · 1'])
  await p.keyboard.press('Escape')
  // 子对话里点「启动工作流」：在子对话这块面板内换成那次运行的视图，标题栏左边能返回子对话，
  // 右边是 ⋯ 和 ✕（✕ 关掉子对话面板本身，和返回不一样），返回后子对话原样回来
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    // 演示数据里没有子对话：照父对话里的工作流任务造一个，并补一条「启动工作流」的调用
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const parent = db.tasks.find((x) => x.title.includes('购物车'))
      const wf = db.tasks.find((x) => x.mode === 'workflow' && x.runs?.length && x.projectId === parent.projectId)
      if (!wf) return
      db.tasks = db.tasks.filter((x) => x.id !== 'demo-child-run')
      const child = structuredClone(wf)
      Object.assign(child, {
        id: 'demo-child-run',
        parentTaskId: parent.id,
        rootTaskId: parent.id,
        title: '子对话：到货提醒',
      })
      child.messages.splice(1, 0, {
        id: 'demo-child-tool',
        role: 'agent',
        agentId: '',
        step: '',
        text: '',
        at: new Date().toISOString(),
        tools: [
          {
            kind: 'other',
            name: 'MCP__panel__start_plan',
            label: '',
            detail: '',
            input: JSON.stringify({ input: '给商品详情页加「到货提醒」' }),
            output: '',
            ms: 1200,
          },
        ],
      })
      db.tasks.push(child)
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    const gotoTask = async () => {
      await p.reload()
      await p.waitForTimeout(500)
      if (!(await p.getByTitle('Token 用量').count())) {
        await p.getByText('购物车右上角', { exact: false }).first().click()
        await p.waitForTimeout(600)
      }
    }
    /** 输入框上方的「子对话」→ 全部 → 打开那个子对话 */
    const openChild = async () => {
      await gotoTask()
      await p.getByRole('button', { name: /^子对话/ }).click()
      await p.getByRole('button', { name: '全部' }).click()
      await p.getByText('子对话：到货提醒').first().click()
      await p.waitForTimeout(400)
    }
    await openChild()
    await check(p, '子对话-面板', ['子对话：到货提醒'])
    const runTitle = p.locator('button[title="打开这次运行的对话"]')
    if (!(await runTitle.count())) errors.push('子对话：工作流那几行没有「打开这次运行的对话」的入口')
    // 点「启动工作流」这一行：面板内换成这次运行的视图，不是把内容铺在子对话里
    await runTitle.first().click()
    await check(p, '子对话-运行视图', ['子对话：到货提醒', '第 1 次运行'])
    if (!(await p.getByRole('button', { name: '返回子对话' }).count()))
      errors.push('子对话运行视图：标题栏左边没有返回子对话的按钮')
    if (!(await p.getByRole('button', { name: '关闭子对话面板' }).count()))
      errors.push('子对话运行视图：标题栏右边没有关闭子对话面板的按钮')
    // 子对话启动的工作流也能补充要求：输入框跟着放进运行视图底下，盖住的子对话里不再留一个
    {
      const box = await p.evaluate(() => {
        const view = document.querySelector('button[aria-label="返回子对话"]')?.closest('.absolute')
        return {
          inView: view?.querySelectorAll('#follow-up').length ?? 0,
          under: view?.parentElement ? [...view.parentElement.querySelectorAll('#follow-up')].length : 0,
        }
      })
      if (box.inView !== 1) errors.push(`子对话运行视图：底下应该有一个输入框（现在 ${box.inView} 个）`)
      else if (box.under !== 1) errors.push(`子对话运行视图：被盖住的子对话里还留着输入框（共 ${box.under} 个）`)
    }
    // 窄窗口：标题截断，但返回和 ✕ 不能被挤掉（手机上子对话面板占满整个宽度）
    {
      await p.setViewportSize({ width: 420, height: 860 })
      await p.waitForTimeout(300)
      const back = await p.getByRole('button', { name: '返回子对话' }).boundingBox()
      const close = await p.getByRole('button', { name: '关闭子对话面板' }).boundingBox()
      if (!back || !close) errors.push('子对话运行视图（窄窗口）：返回或关闭按钮不见了')
      else if (back.x < 0 || close.x + close.width > 420)
        errors.push(`子对话运行视图（窄窗口）：标题把按钮挤出视口（返回 ${back.x}，关闭 ${close.x + close.width}）`)
      await check(p, '子对话-运行视图-窄窗口')
      await p.setViewportSize({ width: 1440, height: 900 })
      await p.waitForTimeout(300)
    }
    // 返回：回到子对话，不是关掉面板
    await p.getByRole('button', { name: '返回子对话' }).click()
    await p.waitForTimeout(400)
    await check(p, '子对话-返回', ['子对话：到货提醒'])
    if (await p.getByRole('button', { name: '返回子对话' }).count())
      errors.push('子对话运行视图：点了返回，运行的视图还在')
    // 这一次运行的卡片也进同一个视图
    await runTitle.last().click()
    await check(p, '子对话-运行视图-卡片')
    // ✕：关掉子对话面板本身，回到父对话的文件面板
    await p.getByRole('button', { name: '关闭子对话面板' }).click()
    await p.waitForTimeout(400)
    await check(p, '子对话-关闭面板', ['购物车右上角'])
    if (await p.getByText('子对话：到货提醒').count()) errors.push('子对话运行视图：点 ✕ 后子对话面板还在')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await gotoTask()
  }
  // 回复完成后思考和工具调用收进一个折叠，折叠行写这段做了什么；点开能看到过程，再点收起
  {
    const fold = p.getByRole('button', { name: /查看 \d+ 个文件/ }).first()
    await fold.click().catch(() => errors.push('任务：回复完成后没有收起过程的折叠行'))
    await check(p, '任务-展开过程', ['思考过程'])
    await fold.click().catch(() => {})
  }
  // 窄版右栏的右键菜单：能弹出，而且整个菜单都在视口里（不能溢出去）
  {
    const compactRow = p.locator('button[title="package.json"]').first()
    const cb = await compactRow.boundingBox()
    if (!cb) errors.push('任务右栏：没有列出 package.json')
    else {
      await p.mouse.click(cb.x + 40, cb.y + cb.height / 2, { button: 'right' })
      const box = await p
        .locator('[role="menu"]')
        .first()
        .boundingBox()
        .catch(() => null)
      if (!box) errors.push('任务右栏：右键没有弹出菜单')
      else {
        const vw = p.viewportSize().width
        const vh = p.viewportSize().height
        if (box.x < 0 || box.y < 0 || box.x + box.width > vw || box.y + box.height > vh)
          errors.push(`任务右栏：右键菜单超出视口（${JSON.stringify(box)}，视口 ${vw}×${vh}）`)
        await check(p, '任务-右栏右键菜单')
      }
      await p.keyboard.press('Escape')
      await p
        .locator('[role="menu"]')
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
    }
  }
  // 按 Agent 显示的对话：滚到回复中部时「谁 + 什么模型」固定在滚动区顶部，下一轮顶走。
  // 演示内容不够长，先把这一轮撑高，再滚到中部看署名行的位置
  {
    const stuck = await p.evaluate(async () => {
      const sc = [...document.querySelectorAll('div')].find((el) => el.className === 'flex-1 overflow-y-auto')
      const row = [...document.querySelectorAll('*')].find((el) => getComputedStyle(el).position === 'sticky')
      if (!sc || !row) return 'no-sticky'
      const col = row.parentElement
      const pad = document.createElement('div')
      pad.style.height = '1800px'
      col.appendChild(pad)
      sc.scrollTop = 700
      await new Promise((r) => setTimeout(r, 250))
      const top = Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top)
      sc.scrollTop = 900
      await new Promise((r) => setTimeout(r, 250))
      const top2 = Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top)
      return { top, top2, bg: getComputedStyle(row).backgroundColor }
    })
    if (stuck === 'no-sticky') errors.push('署名吸顶：按 Agent 显示的对话里没有吸顶的署名行')
    else if (stuck.top !== 0 || stuck.top2 !== 0)
      errors.push(`署名吸顶：滚到回复中部时署名行没固定在顶部（top=${stuck.top}/${stuck.top2}）`)
    await p.evaluate(() => {
      const sc = [...document.querySelectorAll('div')].find((el) => el.className === 'flex-1 overflow-y-auto')
      sc.scrollTop = 0
    })
    await check(p, '任务-署名吸顶')
  }
  // 启动命令只留图标，点开才显示完整命令
  const cmd = p.getByRole('button', { name: '查看启动命令' }).first()
  if (!(await cmd.count())) errors.push('任务：没有启动命令按钮')
  else {
    await cmd.click()
    await check(p, '任务-启动命令', ['acceptEdits'])
    await p.keyboard.press('Escape')
  }
  if (!(await p.getByPlaceholder('查找文件').count())) errors.push('任务：没有文件搜索框')
  if (!(await p.getByLabel('刷新文件').first().count())) errors.push('任务：没有「刷新文件」')
  // 从外面把文件拖到消息区（不是输入框）也算引入到要求里：拖入时整页提示，松开后进附件条和内联卡片；
  // 只拖文字时不拦截浏览器默认行为
  {
    const dropped = await p.evaluate(async () => {
      const sc = [...document.querySelectorAll('div')].find((el) => el.className === 'flex-1 overflow-y-auto')
      if (!sc) return { error: '没有消息区' }
      const box = sc.getBoundingClientRect()
      const at = (dt, x, y) => ({ bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y })
      const file = new DataTransfer()
      file.items.add(new File(['dropped from the message area'], '页面拖入.txt', { type: 'text/plain' }))
      // 模拟真实拖拽：先在消息区进入、在子元素之间移动（enter/leave 交错），提示不能闪掉
      sc.dispatchEvent(new DragEvent('dragenter', at(file, box.left + 80, box.top + 70)))
      sc.dispatchEvent(new DragEvent('dragover', at(file, box.left + 90, box.top + 80)))
      await new Promise((r) => setTimeout(r, 200))
      const inner = sc.querySelector('div')
      if (inner) inner.dispatchEvent(new DragEvent('dragenter', at(file, box.left + 100, box.top + 90)))
      sc.dispatchEvent(new DragEvent('dragleave', at(file, box.left + 100, box.top + 90)))
      await new Promise((r) => setTimeout(r, 250))
      const hint = document.body.textContent.includes('松开鼠标，把文件附到要求里')
      const inputHighlighted = !!document.querySelector('#follow-up')?.closest('.border-accent')
      // 只拖文字：不能 preventDefault
      const text = new DataTransfer()
      text.setData('text/plain', '一段文字')
      const textEvent = new DragEvent('dragover', at(text, box.left + 90, box.top + 80))
      sc.dispatchEvent(textEvent)
      sc.dispatchEvent(new DragEvent('drop', at(file, box.left + 90, box.top + 80)))
      await new Promise((r) => setTimeout(r, 1200))
      return {
        hint,
        inputHighlighted,
        textPrevented: textEvent.defaultPrevented,
        hintAfterDrop: document.body.textContent.includes('松开鼠标，把文件附到要求里'),
        chip: !!document.querySelector('[data-chip="file"][data-name="页面拖入.txt"]'),
        inline: document.body.textContent.includes('页面拖入.txt'),
      }
    })
    if (dropped.error) errors.push(`拖文件：${dropped.error}`)
    else {
      if (!dropped.hint) errors.push('拖文件：在消息区拖入时没有整页提示')
      if (dropped.inputHighlighted) errors.push('拖文件：页面提示和输入框高亮同时出现，叠了两层提示')
      if (dropped.textPrevented) errors.push('拖文件：只拖文字时被拦截了（应该保持浏览器默认行为）')
      if (dropped.hintAfterDrop) errors.push('拖文件：松开后整页提示没有消失')
      if (!dropped.chip) errors.push('拖文件：在消息区松开后要求里没有这张卡片')
      if (!dropped.inline) errors.push('拖文件：附件没有出现在要求里')
    }
    await check(p, '任务-页面拖文件')
    // 这个附件只用于检查拖入，清掉以免影响后面的步骤
    await p
      .locator('[data-chip="file"][data-name="页面拖入.txt"]')
      .first()
      .press('Backspace')
      .catch(() => {})
  }
  // 工作流任务：任务进度按节点列出，节点下面挂验收和它自己派出的子 Agent，窄窗口里从标题栏点开
  await p.getByText('商品详情页增加', { exact: false }).first().click()
  const workflowTaskUrl = p.url()
  await p.getByRole('button', { name: '任务进度' }).click()
  // 演示任务是启动后在后台模拟执行的，轮到这个任务时可能还没跑完：等测试节点的子 Agent 出现再断言
  await p
    .getByText('子角色 · 单元测试', { exact: false })
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {})
  await check(p, '任务-节点与子Agent', ['分析需求、拆分任务', '单元测试', '子角色 · 单元测试'])
  // 执行中发消息：在聊天页新建一个对话，趁它还在回复时再发一条。消息立刻出现在对话里，
  // 没有「排队」卡片、也没有「下一条」的排队提示
  await p.goto(base + '#/chat')
  await p.locator('#task-prompt').fill('整理一下这个项目的模块结构')
  await p.waitForTimeout(300)
  const opened = await p
    .locator('#task-prompt')
    .press('Enter')
    .then(
      () => p.locator('#follow-up').waitFor({ timeout: 20000 }),
      () => undefined,
    )
    .then(
      () => true,
      () => false,
    )
  if (!opened) errors.push('执行中发消息：新建对话后没有进入任务页')
  else {
    await p.locator('#follow-up').fill('顺手看看测试配置')
    await p.locator('#follow-up').press('Enter')
    await p
      .getByText('顺手看看测试配置', { exact: false })
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('执行中发消息：消息没有立刻出现在对话里'))
    if (await p.getByText('排队', { exact: false }).count()) errors.push('执行中发消息：还能看到「排队」')
    if (await p.getByText('下一条', { exact: true }).count()) errors.push('执行中发消息：还能看到「下一条」的排队卡片')
    await check(p, '任务-执行中发消息')
  }
  await p.goto(base + '#/workflows')
  await check(p, '工作流', ['流程图', '主流程'])
  // 内置工作流列表：整理后的能力块和新补的四个流程都要能正常显示，不重复、不溢出
  await p.getByRole('button', { name: '添加内置或导入的工作流' }).first().click()
  await p.getByText('从内置工作流添加').first().click()
  await check(p, '工作流-内置列表', ['日常开发', '依赖升级与安全', '发布与回滚', '项目初始化'])
  await p.keyboard.press('Escape')
  // 属性栏的宽度可调：选中节点后拖左边缘，变宽并记住
  await p.getByText('处理并推荐').first().click()
  const inspector = p.locator('aside[aria-label="属性"]')
  const grip = p.locator('[role="separator"][aria-label="拖动调整属性栏的宽度"]')
  const width = async () => (await inspector.boundingBox())?.width ?? 0
  const before = await width().catch(() => 0)
  const g = await grip.boundingBox().catch(() => null)
  if (!g) errors.push('工作流-属性栏：找不到拖动条')
  else {
    await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await p.mouse.down()
    await p.mouse.move(g.x - 160, g.y + g.height / 2, { steps: 10 })
    await p.mouse.up()
    await p.waitForTimeout(300)
    if (Math.abs(before - 380) > 2) errors.push(`工作流-属性栏：默认宽度是 ${before}，不是 380`)
    const after = await width()
    if (after < before + 100) errors.push(`工作流-属性栏：拖动后宽度是 ${after}，没有变宽`)
  }
  await check(p, '工作流-属性栏宽度')
  // 执行步骤可以折叠：收起后只剩标题行和一行摘要，输入框不再占高度；再点一下展开回来
  {
    const fold = p.getByRole('button', { name: '收起这一步' }).first()
    if (!(await fold.count())) errors.push('工作流-步骤折叠：步骤上没有折叠按钮')
    else {
      await fold.click()
      await p.waitForTimeout(300)
      if (!(await p.getByRole('button', { name: '展开这一步' }).count()))
        errors.push('工作流-步骤折叠：收起后按钮没有变成「展开这一步」')
      if (await p.getByLabel('这一步要做的事').count())
        errors.push('工作流-步骤折叠：收起后「这一步要做的事」还占着位置')
      await check(p, '工作流-步骤折叠')
      await p.getByRole('button', { name: '展开这一步' }).first().click()
      await p.waitForTimeout(300)
      if (!(await p.getByLabel('这一步要做的事').count())) errors.push('工作流-步骤折叠：再点一下没有展开')
    }
  }
  // 内置工作流：添加后连同 Agent 一起建好，直接打开
  await p.getByRole('button', { name: '添加内置或导入的工作流' }).click()
  await p.getByRole('menuitem', { name: '从内置工作流添加' }).click()
  await check(p, '内置工作流', ['日常开发', '功能开发（OpenSpec）', 'Blender 建模与动画'])
  await p.getByRole('button', { name: '添加', exact: true }).first().click()
  // 要建好几个 Agent，演示里每个请求都有模拟的延迟，等弹窗关掉
  await p.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20000 })
  await check(p, '内置工作流-添加后', ['识别现场与设计', '文档与提交'])
  // 项目里新建对话：输入框上可以选择用不用项目设置的 Agent，对话页不能再换 Agent 和参数
  await p.goto(base)
  const agentSwitch = p.getByRole('switch', { name: '使用项目设置的角色' })
  await agentSwitch.waitFor({ timeout: 10000 }).catch(() => errors.push('新建任务：没有「使用项目设置的角色」开关'))
  if (await agentSwitch.count()) {
    if ((await agentSwitch.getAttribute('aria-checked')) !== 'true') errors.push('新建任务：开关默认没有勾选')
    // 开关只显示图标，Agent 名字放在 title 里
    if ((await agentSwitch.textContent())?.trim()) errors.push('新建任务：Agent 开关还显示文字')
    if (!(await agentSwitch.getAttribute('title'))) errors.push('新建任务：Agent 开关没有说明')
    await check(p, '新建任务-Agent开关')
    // 不勾选后换成 CLI / 模型的选择
    await agentSwitch.click()
    await p.waitForTimeout(300)
    if ((await agentSwitch.getAttribute('aria-checked')) !== 'false') errors.push('新建任务：开关点一下没有关掉')
    if (!(await p.getByTitle('对话用的 Agent').count())) errors.push('新建任务：关掉 Agent 后没有显示 CLI 选择')
    await check(p, '新建任务-不用Agent')
    await agentSwitch.click()
  }
  await p.locator('#task-prompt').fill('分析一下这个项目的结构')
  await p.waitForTimeout(300)
  await p.locator('#task-prompt').press('Enter')
  await p
    .locator('#follow-up')
    .waitFor({ timeout: 20000 })
    .catch(() => errors.push('对话页：没有打开输入框'))
  // 对话页输入框里只剩「提问」开关和 CLI / 模型，没有换 Agent 和改参数的地方
  if (!(await p.getByRole('button', { name: 'AI 有问题时问我' }).count())) errors.push('对话页：没有「提问」开关')
  for (const name of ['参数', '无角色，直接用 Agent']) {
    if (await p.getByText(name, { exact: false }).count()) errors.push(`对话页：还能看到「${name}」`)
  }
  await check(p, '对话-不能换Agent和参数')
  // AI 分析执行结果：新建分析对话，代码问题按模块分组带「修复」，角色和工作流的优化可以逐条或全部应用
  await p.goto(workflowTaskUrl)
  await p.getByRole('button', { name: '更多操作' }).click()
  await p.getByRole('menuitem', { name: 'AI 分析执行结果' }).click()
  await p.getByRole('dialog').getByRole('button', { name: '开始分析' }).click()
  await p.getByText('工作流优化', { exact: true }).waitFor({ timeout: 20000 })
  await p.getByRole('button', { name: '看差异' }).first().click()
  await check(p, 'AI分析-建议', ['代码问题', '商品卡片', '面板框架', '工作流优化', '先确认范围', '应用到工作流'])
  // 项目代码的问题能开子对话去修；面板框架的问题在非面板源代码项目里修不了
  await p.getByRole('button', { name: '修复', exact: true }).first().click()
  await p
    .getByRole('button', { name: /处理中|查看/ })
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => errors.push('AI 分析：点了「修复」没有开出子对话'))
  await check(p, 'AI分析-修复子对话')
  await p.getByRole('button', { name: /全部应用/ }).click()
  await check(p, 'AI分析-已应用', ['已应用'])
  await p.goto(base + '#/agents')
  await check(p, 'Agent', ['命令预览'])
  // 内置 Agent：手动添加，已经随工作流建好的标成已添加
  await p.getByRole('button', { name: '添加内置角色' }).first().click()
  await check(p, '内置Agent', ['通用约束', '调研', '方案设计', '已添加'])
  await p.keyboard.press('Escape')
  // Agent 的引入层级和参数的选项编辑（带序号的卡片、回车添加）
  // 角色页按「概览 / 角色设定 / 参数 / Skill 与开场白」分页
  await p.getByText('评审', { exact: true }).first().click()
  await p.getByRole('tab', { name: /^参数/ }).click()
  await p.getByRole('button', { name: /\{\{vcs\}\}/ }).click()
  await p.getByRole('textbox', { name: '新选项' }).fill('svn')
  await p.getByRole('textbox', { name: '新选项' }).press('Enter')
  await p.getByRole('button', { name: '删除选项「svn」' }).scrollIntoViewIfNeeded()
  await check(p, 'Agent-参数选项', ['svn'])
  // 参数联动：后面的参数按前面的选择决定显示，规则在参数卡片里配
  await p.getByRole('combobox', { name: '显示条件' }).click()
  await p.getByRole('option', { name: /（target）/ }).click()
  await p.getByRole('group', { name: '条件取值' }).scrollIntoViewIfNeeded()
  await check(p, 'Agent-参数联动', ['选了其中一个时', '选项跟随', '联动'])
  await p.getByRole('tab', { name: /^角色设定/ }).click()
  await check(p, '角色-角色设定', ['通用约束', '实际交给它的设定'])
  await p.getByRole('tab', { name: /^概览/ }).click()
  await check(p, '角色-概览', ['能开启子对话', '能启动计划', '运行环境'])
  await p.goto(base + '#/library')
  await check(p, 'Skills与命令', ['commit-message', 'code-review'])
  await p.getByRole('radio', { name: '自带 Skill' }).click()
  await check(p, '自带Skill', ['brainstorming', 'blender', '版本控制'])
  await p.getByRole('radio', { name: 'Skill', exact: true }).click()
  await p.getByText('commit-message', { exact: true }).first().click()
  await check(p, 'Skill编辑', ['复制给别的 Agent', '保存'])
  await p.getByRole('button', { name: 'AI 优化' }).click()
  await p.getByRole('dialog').getByRole('textbox', { name: '描述' }).fill('步骤写得再具体一些')
  await p.keyboard.press('Enter')
  await check(p, 'Skill-AI优化', ['格式校验通过', 'SKILL.md'])
  await p.getByRole('button', { name: '应用修改' }).click()
  await p.keyboard.press('Escape')
  // 命令：「所有 Agent」的命令和 AI 创建（上面的 Skill 编辑框还开着，先关掉）
  await p.getByRole('dialog').getByText('关闭', { exact: true }).click()
  await p.getByRole('radio', { name: '命令' }).click()
  await check(p, '命令-所有Agent', ['/changelog', '所有 Agent'])
  await p.getByRole('button', { name: 'AI 创建' }).click()
  await p.getByRole('dialog').getByRole('textbox', { name: '描述' }).fill('/i18n：找出没翻译的文案，补上英文')
  await p.keyboard.press('Enter')
  await check(p, '命令-AI创建', ['格式校验通过', '命令文件（所有 Agent 共用）'])
  await p.getByRole('button', { name: '创建命令' }).click()
  await check(p, '命令-AI创建后', ['/i18n'])
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
  await p.getByText('check', { exact: true }).first().waitFor({ timeout: 15000 })
  await p.waitForTimeout(600)
  await check(p, 'UI设计-写入', ['replace_widget'])
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
  // 默认项断言当前真正默认的那一个（不写成「或」，默认再变时要红）：演示后端固定返回 win32 和
  // gitbash → wsl → powershell → cmd 的顺序，recommendedShell() 选 Git Bash，与跑检查的机器无关
  await check(p, '设置', ['常规', '内容宽度', '命令行环境', 'Git Bash（默认）'])
  await p.getByRole('button', { name: '全局教训', exact: true }).click()
  await check(p, '设置-全局教训', ['改了提示词或界面文案', '加一条'])
  await p.getByRole('button', { name: '字体', exact: true }).click()
  await check(p, '设置-字体', ['Maple Mono NL', '字间距', '空格宽度'])
  await p.getByRole('button', { name: '风格库' }).click()
  await check(p, '设置-风格库', ['暗黑奇幻'])
  await p.getByRole('button', { name: 'Agent', exact: true }).first().click()
  await p.getByText('添加其他 Agent').scrollIntoViewIfNeeded()
  await check(p, '设置-CLI', ['添加其他 Agent', 'Gemini CLI'])
  // 三档模型的上下文、最大输出：默认按模型自动填，手动改了能恢复自动；Codex 不接受最大输出
  await p.getByRole('dialog').getByText('Claude Code', { exact: true }).first().click()
  // 上下文和最大输出默认收在折叠里，点开第一档才看得到输入框
  await p
    .getByRole('dialog')
    .getByRole('button', { name: /^上下文/ })
    .first()
    .click()
  const ctx = p.getByRole('dialog').getByLabel('上下文', { exact: true }).first()
  await ctx.scrollIntoViewIfNeeded()
  await ctx.fill('500k')
  await ctx.press('Enter')
  await check(p, '设置-CLI-三档上下文', ['三档模型'])
  // 输入框里直接用灰字显示按模型估出来的值，不再带「自动 ·」
  if (!(await p.getByRole('dialog').getByPlaceholder('128K').count()))
    errors.push('设置-CLI-三档上下文：最大输出没有按模型自动填')
  if ((await ctx.inputValue()) !== '500K')
    errors.push(`设置-CLI-三档上下文：手填的值显示成了「${await ctx.inputValue()}」`)
  await p.getByRole('dialog').getByRole('button', { name: '恢复自动' }).first().click()
  // 清空要等设置保存、重新渲染；CI 的机器慢，立刻读会读到旧值
  for (let i = 0; i < 30 && (await ctx.inputValue()) !== ''; i++) await p.waitForTimeout(100)
  if ((await ctx.inputValue()) !== '') errors.push('设置-CLI-三档上下文：恢复自动后没有清空')
  await p.getByRole('dialog').getByText('Codex', { exact: true }).first().click()
  await p.getByText('没有设置最大输出的参数').first().scrollIntoViewIfNeeded()
  await check(p, '设置-CLI-Codex档位', ['没有设置最大输出的参数'])
  // 报错的地方都有「AI 处理」：演示里 Pi 卸载会失败（留着启动脚本），点了在统一的弹窗里看 AI 的处理
  await p.getByRole('dialog').getByText('Pi', { exact: true }).first().click()
  await p.getByRole('button', { name: '安装', exact: true }).first().click()
  await p.getByText('安装完成').first().waitFor({ timeout: 8000 })
  // 装好后才有的：开关（离线运行默认开着）和扩展包
  await p.getByRole('list', { name: '已装的扩展包' }).scrollIntoViewIfNeeded()
  await check(p, '设置-CLI-Pi扩展包', ['离线运行', '扩展包', 'npm:@example/pi-web-tools'])
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
  await check(p, '设置-API-识别', ['在本机 Agent 的配置里识别到 2 个 API', 'Codex · openrouter'])
  await p.getByRole('button', { name: '存到 API 配置' }).first().click()
  await check(p, '设置-API-已存', ['已在列表中', '一键更新', '映射模型'])
  // 授权：检测外部 CLI，在面板里完成浏览器授权（演示里模拟），退出后回到未授权
  await p.getByRole('button', { name: '授权', exact: true }).first().click()
  await check(p, '设置-授权', ['GitHub CLI', '浏览器授权', '用 Token 授权'])
  await p.getByRole('button', { name: '浏览器授权' }).first().click()
  await p
    .getByText('一次性授权码')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('授权：没有显示一次性授权码'))
  await check(p, '设置-授权-进行中', ['等待浏览器完成授权', 'ABCD-1234', '取消授权'])
  await p
    .getByText('已授权', { exact: true })
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('授权：浏览器授权没有完成'))
  await check(p, '设置-授权-完成', ['已授权', 'demo-user'])
  await p.getByRole('button', { name: '退出登录' }).first().click()
  await p.getByRole('dialog').getByRole('button', { name: '退出登录' }).click()
  await p
    .getByRole('button', { name: '浏览器授权' })
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('授权：退出后没有回到未授权'))
  await check(p, '设置-授权-已退出', ['未授权', '浏览器授权'])
  // 回到 CLI 的默认 CLI 页（部署在它下面）
  await p.getByRole('button', { name: 'Agent', exact: true }).first().click()
  await p.getByRole('dialog').getByText('默认 Agent', { exact: true }).first().click()
  // 部署：全局说明写进各 CLI，技能默认不选，选了再部署
  await p.getByRole('button', { name: '部署', exact: true }).first().click()
  await check(p, '设置-部署', ['全局说明（AGENTS.md）', '写到哪些 Agent', '要部署的技能', 'grilling'])
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
  // 侧栏项目分组：默认按添加时间排（演示项目的时间各不相同），拖拽手柄能调整顺序并持久化，刷新后还是新顺序
  const projectRows = () =>
    p
      .locator('[data-sidebar] section button[title^="打开项目「"]')
      .evaluateAll((els) => els.map((e) => (e.getAttribute('title') ?? '').match(/「(.+?)」/)?.[1] ?? ''))
  await p.goto(base + '#/projects')
  const order0 = await projectRows()
  assert.deepEqual(
    order0.slice(0, 4),
    ['商城前台', '运营后台', '客户端主工程', '旧官网'],
    `侧栏项目没有按添加时间排序：${order0.join('、')}`,
  )
  await check(p, '侧栏-项目按添加时间', ['商城前台', '运营后台'])
  // 拖住「运营后台」的手柄，放到「商城前台」上：出现插入提示
  const orderGrip = p.getByRole('button', { name: '拖动调整「运营后台」的顺序' })
  const target = (await p.locator('[data-sidebar] section').nth(0).boundingBox()) ?? null
  if (!(await orderGrip.count()) || !target) errors.push('侧栏-拖拽：没有拖拽手柄')
  else {
    // 无头浏览器的鼠标拖不出 HTML5 拖放，用脚本发拖放事件（和 UI 设计拖图片的写法一样）
    await p.evaluate(() => {
      window.__dt = new DataTransfer()
      const handle = document.querySelector('[aria-label="拖动调整「运营后台」的顺序"]')
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }))
    })
    await p.waitForTimeout(150)
    await p.evaluate(() => {
      const section = document.querySelectorAll('[data-sidebar] section')[0]
      const r = section.getBoundingClientRect()
      section.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__dt,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      )
    })
    await p.waitForTimeout(150)
    await check(p, '侧栏-拖拽插入提示')
    await p.evaluate(() => {
      const section = document.querySelectorAll('[data-sidebar] section')[0]
      const r = section.getBoundingClientRect()
      section.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__dt,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      )
      document
        .querySelector('[aria-label="拖动调整「运营后台」的顺序"]')
        .dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }))
    })
    await p.waitForTimeout(400)
    const order1 = await projectRows()
    assert.deepEqual(order1.slice(0, 2), ['运营后台', '商城前台'], `拖拽后顺序不对：${order1.join('、')}`)
    await check(p, '侧栏-拖拽后顺序', ['运营后台', '商城前台'])
    // 刷新后仍是新顺序（演示版把顺序存在浏览器里，等价于真实服务端写盘）
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('agent-panel-demo-v3') ?? '{}'))
    assert.ok(
      saved.projects?.every((x) => typeof x.sortOrder === 'number'),
      '拖拽后没有把顺序存下来',
    )
    await p.reload()
    await p.waitForTimeout(600)
    assert.deepEqual((await projectRows()).slice(0, 2), ['运营后台', '商城前台'], '刷新后顺序变了')
    await check(p, '侧栏-刷新后顺序', ['运营后台', '商城前台'])
  }
  // 浅色主题
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
  await p.goto(base + '#/projects')
  await check(p, '项目-浅色', ['任务', '设置'])
  // 浅色主题下再看一眼 Token 浮层：边框、分隔线、速度的颜色都要跟着主题
  {
    await p.goto(base)
    await p.getByText('购物车右上角', { exact: false }).first().click()
    await p.getByTitle('Token 用量').first().click()
    await check(p, '任务-浅色-Token浮层', ['整个运行', '缓存命中'])
    await p.keyboard.press('Escape')
  }
  // 项目首页右侧的文件面板：首屏只读根目录一层，展开哪个目录才读哪一层，收起再展开用缓存。
  // 左侧栏原来的独立文件页已经去掉，这里验证的是同一套 FileExplorer
  {
    await p.goto(base)
    await p.waitForTimeout(400)
    // #/projects 的地址里带项目 id，演示里的 id 每次生成都不一样，从侧栏点进去
    await p.locator('[data-sidebar]').getByText('商城前台').first().click()
    // 面板打开时才开始读文件：清掉之前页面记下的请求，再看打开面板读了哪几层
    await p.evaluate(() => {
      window.__fileCalls = []
    })
    await p.getByRole('button', { name: '显示文件', exact: true }).first().click()
    await p.waitForTimeout(800)
    const panel = p.locator('aside').filter({ has: p.getByPlaceholder('查找文件') })
    const calls = () => p.evaluate(() => (window.__fileCalls ?? []).filter((x, i, a) => a.indexOf(x) === i).join(','))
    const first = await calls()
    if (first !== '') errors.push(`文件面板：打开时不该读整棵树，实际读了「${first || '(根)'}」，应该只读根目录一层`)
    const row = (name) => panel.locator(`button[title="${name}"]`).first()
    // 根目录这一层有 src、tests 和几个文件，没有更深层的内容
    await row('src')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('文件面板：根目录没有列出 src'))
    await row('tests')
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('文件面板：根目录没有列出 tests'))
    if (await row('src/App.tsx').count()) errors.push('文件面板：没展开 src 就列出了它下面的文件')
    if (await panel.getByText('共 20000 个文件', { exact: false }).count())
      errors.push('文件面板：还在显示全量文件数量')
    await check(p, '文件面板-根目录一层', ['src', 'README.md'])
    // 展开 src：这时才读 src 这一层
    await row('src').click()
    await row('src/App.tsx')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('文件面板：展开 src 后没有读它这一层'))
    if (!(await calls()).split(',').includes('src')) errors.push('文件面板：展开 src 时没有请求这一层')
    await check(p, '文件面板-展开一层', ['api', 'App.tsx'])
    // 收起再展开：不重复请求
    await row('src').click()
    await p.waitForTimeout(200)
    const before = await p.evaluate(() => (window.__fileCalls ?? []).length)
    await row('src').click()
    await row('src/App.tsx')
      .waitFor({ timeout: 3000 })
      .catch(() => {})
    const after = await p.evaluate(() => (window.__fileCalls ?? []).length)
    if (after !== before) errors.push(`文件面板：收起再展开又请求了一次（${before} → ${after}）`)
    // 名称搜索：还没展开的深层文件也能搜到，结果是平铺的
    await panel.getByPlaceholder('查找文件').fill('Restock')
    await panel
      .locator('button[title="src/components/RestockButton.tsx"]')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('文件面板：名称搜索没有找到还没展开的深层文件'))
    await check(p, '文件面板-名称搜索', ['RestockButton'])
    await panel.getByPlaceholder('查找文件').fill('')
    await p.waitForTimeout(400)

    // 右键菜单：文件行、文件夹行、空白处各一次；右键本身不能打开文件或展开目录
    const menu = () => p.locator('[role="menu"]')
    const menuText = async () => (await menu().innerText()).replace(/\s+/g, ' ')
    const closeMenu = async () => {
      await p.keyboard.press('Escape')
      await menu()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
    }
    // 文件行右键：出现菜单项，但文件没有被打开（没有弹出文件窗口）
    await row('package.json').click({ button: 'right' })
    await menu()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('文件右键：没有弹出菜单'))
    const fileMenu = await menuText().catch(() => '')
    for (const item of ['打开', '复制相对路径', '复制绝对路径', '在文件夹中打开'])
      if (!fileMenu.includes(item)) errors.push(`文件右键：菜单里没有「${item}」`)
    if (await p.getByRole('dialog').count()) errors.push('文件右键：右键打开了文件窗口')
    await check(p, '文件面板-右键菜单')
    await closeMenu()
    if (await p.getByRole('dialog').count()) errors.push('文件右键：菜单项没点，文件窗口却开着')
    // 文件夹行右键：菜单是「展开」，目录没有被展开
    await row('tests').click({ button: 'right' })
    await menu()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('文件夹右键：没有弹出菜单'))
    const dirMenu = await menuText().catch(() => '')
    for (const item of ['展开', '复制相对路径', '在文件夹中打开'])
      if (!dirMenu.includes(item)) errors.push(`文件夹右键：菜单里没有「${item}」`)
    // 第一项必须是「展开」；整行比较，避免「在文件夹中打开」里的「打开」被误判
    const dirItems = await menu()
      .locator('[role="menuitem"]')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
    if (dirItems[0] !== '展开') errors.push(`文件夹右键：第一项是「${dirItems[0]}」，不是「展开」`)
    if (dirItems.includes('打开')) errors.push('文件夹右键：出现了只给文件的「打开」')
    if (await row('tests/cart.test.ts').count()) errors.push('文件夹右键：右键把目录展开了')
    await check(p, '文件面板-文件夹右键菜单')
    await closeMenu()
    // 空白处右键：整棵树的菜单。
    // 行的按钮是整宽的，右上角又被搜索栏占着，所以在树的右键触发元素（min-h-full 那层）
    // 右下角的空白上点真实鼠标。每次先把滚动区滚到底，保证这块空白在视口里。
    const scroll = panel.locator('div.min-h-full').first().locator('..')
    const blankTrigger = () => panel.locator('div.min-h-full').first()
    const openBlankMenu = async (label) => {
      await scroll
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        .catch(() => {})
      const tb = await blankTrigger()
        .boundingBox()
        .catch(() => null)
      if (!tb) {
        errors.push(`${label}：找不到文件树容器`)
        return
      }
      await p.mouse.click(tb.x + tb.width - 24, tb.y + tb.height - 8, { button: 'right' })
      await menu()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push(`${label}：没有弹出菜单`))
    }
    await openBlankMenu('空白处右键')
    const blankMenu = await menuText().catch(() => '')
    for (const item of ['刷新', '全部展开', '全部收起', '复制项目路径', '在文件夹中打开'])
      if (!blankMenu.includes(item)) errors.push(`空白处右键：菜单里没有「${item}」`)
    await check(p, '文件面板-空白处右键菜单')
    await closeMenu()
    await menu()
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    // 先测「全部收起」：此时 src 还开着，收起后子项应该消失
    await openBlankMenu('空白处右键')
    const collapse = menu().locator('[role="menuitem"]').filter({ hasText: '全部收起' })
    if (!(await collapse.count())) errors.push('空白处右键：没有「全部收起」')
    else {
      // 用真实鼠标点：Radix 的菜单项要按下和抬起都落在同一个元素上才触发
      const cb = await collapse.boundingBox()
      if (!cb) errors.push('空白处右键：「全部收起」不可见')
      else {
        await p.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2)
        await p.waitForTimeout(400)
        if (await p.locator('[role="menu"]').count())
          errors.push('空白处右键：点了「全部收起」菜单没有关闭（可能没点中）')
      }
    }
    await menu()
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    const collapsedRows = await panel
      .locator('button[title="src/App.tsx"]')
      .count()
      .catch(() => 0)
    if (collapsedRows) errors.push('全部收起：收起后目录下面还显示着子项')
    // 收起后没有展开的目录：这一项应该变灰
    await openBlankMenu('空白处右键')
    const collapseItem = menu().locator('[role="menuitem"]').filter({ hasText: '全部收起' })
    const disabled = await collapseItem.getAttribute('data-disabled').catch(() => null)
    if (disabled === null) errors.push('全部收起：没有展开的目录时菜单项没有禁用')
    await p.keyboard.press('Escape')
    await menu()
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    // 最后测「全部展开」：只作用于已经读过的层，不会新读没有出现过的目录。
    // 放在最后是因为展开后行会铺满可视区，右侧就不再有空白能点开菜单了。
    const beforeExpand = await calls()
    await openBlankMenu('空白处右键')
    const expandItem = menu().locator('[role="menuitem"]').filter({ hasText: '全部展开' })
    const eb = await expandItem.boundingBox().catch(() => null)
    if (!eb) errors.push('空白处右键：没有「全部展开」')
    else await p.mouse.click(eb.x + eb.width / 2, eb.y + eb.height / 2)
    await p.waitForTimeout(900)
    const afterExpand = await calls()
    const requested = afterExpand.split(',').filter((x) => x && !beforeExpand.split(',').includes(x))
    const known = await panel
      .locator('button[title]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''))
    const unknown = requested.filter((p2) => !known.some((k) => k.startsWith(p2 + '/')))
    if (unknown.length) errors.push(`全部展开：读了界面上还没有的目录「${unknown.join('、')}」`)
    await p.waitForTimeout(300)
    await check(p, '文件面板-全部展开')
    await p.keyboard.press('Escape')
  }
  // 项目设置：测试步骤和按 Agent 派生的参数都要能正常显示，不能溢出、不能串行
  // 先点侧栏的项目（title 是「打开项目「名字」」）进入项目首页，管理区里有「项目设置」按钮
  const settingsButton = p.getByRole('button', { name: '项目设置' })
  if (!(await settingsButton.count()))
    await p
      .locator('[data-sidebar] button[title^="打开项目「"]')
      // 演示里只有「商城前台」配了测试步骤，按名字点它，不依赖侧栏顺序
      .filter({ hasText: '商城前台' })
      .first()
      .click()
      .catch(() => {})
  if (await settingsButton.count()) {
    await settingsButton.first().click()
    const dlg = p.getByRole('dialog')
    // 设置按左侧的页面分开：常规、必备角色、工作流、测试步骤各看一页
    await check(p, '项目设置-常规', ['推送到远端', '子对话隔离'])
    await dlg.getByRole('button', { name: '必备角色', exact: true }).click()
    await check(p, '项目设置-必备角色', ['统筹', '执行', '文档', '测试验收'])
    await dlg.getByRole('button', { name: '工作流', exact: true }).click()
    await check(p, '项目设置-工作流', ['AI 配置'])
    await dlg
      .getByRole('button', { name: /^测试步骤/ })
      .first()
      .click()
    await check(p, '项目设置-测试步骤', ['AI 生成步骤', 'WSL 发行版', '小改动也跑', '按改动大小决定验证范围'])
    // 项目教训：演示项目里有手动记的和角色记的，按文件生效的显示范围
    await dlg
      .getByRole('button', { name: /^项目教训/ })
      .first()
      .click()
    await check(p, '项目设置-项目教训', ['价格一律用分', '角色记录', 'src/payment/**', '加一条'])
    // AI 初始化：演示项目已经初始化过，重新初始化后写过的文件和推荐设置按组列出，能逐项或全部应用
    await dlg.getByRole('button', { name: 'AI 初始化', exact: true }).click()
    await check(p, '项目设置-AI初始化', ['已于', '重新初始化'])
    await dlg.getByRole('button', { name: '重新初始化' }).click()
    const reviewInit = p.getByRole('button', { name: '查看推荐并应用' })
    await p
      .waitForFunction(
        () =>
          [...document.querySelectorAll('button')].some(
            (b) => b.textContent?.includes('查看推荐并应用') && !b.disabled,
          ),
        null,
        { timeout: 20000 },
      )
      .catch(() => errors.push('AI 初始化：等不到「查看推荐并应用」'))
    await check(p, 'AI初始化-对话', ['写入的文件', 'AGENTS.md'])
    await reviewInit.click().catch(() => {})
    await check(p, 'AI初始化-推荐设置', ['初始化完成', '推荐设置', '全部应用', '工作流', '测试步骤'])
    await p
      .getByRole('button', { name: '全部应用' })
      .click()
      .catch(() => errors.push('AI 初始化：没有「全部应用」'))
    await check(p, 'AI初始化-全部应用', ['已应用'])
    await p
      .getByText('评估后不适用的工作流')
      .scrollIntoViewIfNeeded()
      .catch(() => {})
    await check(p, 'AI初始化-工作流评估', ['评估后不适用的工作流', '可选工作流'])
    await p.keyboard.press('Escape')
    // 项目首页：任务按状态分组；输入和已有对话是同一件事的要求时，提示可以直接发过去
    await p.locator('#task-prompt').click()
    await p.keyboard.type('到货通知的按钮在详情页上点了没反应')
    await check(p, '项目首页-相关对话', ['发到这里', '需要你处理'])
    await p.keyboard.press('ControlOrMeta+a')
    await p.keyboard.press('Backspace')
    // 项目首页的项目教训：点一条打开项目设置的「教训」并展开它，改写过的带改写记录
    await p.getByText('项目教训 · ', { exact: false }).first().scrollIntoViewIfNeeded()
    await check(p, '项目首页-项目教训', ['项目教训 · 4', '已改写', '后台命令报完成后先看用时'])
    await p
      .getByRole('button', { name: /新增支付方式写进/ })
      .first()
      .click()
    await check(p, '项目教训-改写记录', ['改写记录', '为什么改', '提取全局教训'])
    // 提取全局教训：AI 给出的改动逐条勾选，确认后写进去
    await p.getByRole('button', { name: '提取全局教训' }).first().click()
    await p.getByText('把这个项目里换个项目也适用的教训提取出来').first().click()
    await check(p, '提取全局教训', ['确认写入全局教训', '新加'])
    await p.getByRole('button', { name: '确认写入全局教训' }).click()
    await check(p, '提取全局教训-已写入', ['条全局教训'])
    await p.keyboard.press('Escape')
  } else errors.push('项目设置：项目页上没有「项目设置」按钮')

  // 英文界面：切到 English 后对话页的执行中提示和按钮都正常，没有 Queue
  await p.goto(base)
  await p.getByRole('button', { name: '设置', exact: true }).first().click()
  await p.waitForTimeout(1200)
  const lang = p.getByRole('combobox', { name: '语言' })
  if (await lang.count()) {
    // 下拉是把选项渲染在弹层里的自定义列表，不是原生 select
    await lang.click()
    await p
      .getByRole('option', { name: /English/ })
      .first()
      .click()
    await p.waitForTimeout(800)
    await p.goto(base + '#/chat')
    await p.waitForTimeout(1200)
    await p.locator('#task-prompt').fill('Check the module layout')
    await p.waitForTimeout(300)
    await p.locator('#task-prompt').press('Enter')
    await p
      .locator('#follow-up')
      .waitFor({ timeout: 20000 })
      .catch(() => errors.push('英文界面：没有打开对话页'))
    await p.locator('#follow-up').fill('Also check the test setup')
    await p.waitForTimeout(300)
    await p.locator('#follow-up').press('Enter')
    // 发送成功时输入框会被清空；没清空说明没送出去（英文界面里按钮旁边容易看不出状态）
    let cleared = false
    for (let i = 0; i < 30 && !cleared; i++) {
      cleared = (await p.locator('#follow-up').innerText()).trim() === ''
      if (!cleared) await p.waitForTimeout(150)
    }
    if (!cleared) errors.push('英文界面：执行中的消息没有发出去（输入框没清空）')
    await p
      .getByText('Also check the test setup', { exact: false })
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('英文界面：执行中发的消息没有立刻出现'))
    if (await p.getByText('Queue', { exact: false }).count()) errors.push('英文界面：还能看到 Queue')
    await check(p, '英文-执行中发消息')
    // 英文的文件面板：搜索框、计数文案都换成英文
    await p.goto(base)
    await p.waitForTimeout(400)
    await p.locator('[data-sidebar]').getByText('商城前台').first().click()
    await p.getByRole('button', { name: 'Show files', exact: true }).first().click()
    await p.waitForTimeout(900)
    if (!(await p.getByPlaceholder('Find file').count())) errors.push('英文界面：文件面板的搜索框没有换成 Find file')
    if (!(await p.getByText('files read', { exact: false }).count())) errors.push('英文界面：文件面板的计数还是中文')
    const enPanel = p.locator('aside').filter({ has: p.getByPlaceholder('Find file') })
    await enPanel.locator('button[title="src"]').first().click()
    await enPanel
      .locator('button[title="src/App.tsx"]')
      .waitFor({ timeout: 8000 })
      .catch(() => {})
    await check(p, '文件面板-英文', ['files read'])
  } else errors.push('英文界面：设置里没有语言选择')

  // 发出去的图片消息：气泡里直接显示图片，点开浮层能看大图；取不到图时回落成图标，不显示破图
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/chat')
    await p.waitForTimeout(900)
    // 先写文字再附图片：已经有卡片时往输入框里填，会卡在富文本受控内容上
    await p.locator('#task-prompt').fill('看看这张图')
    await p
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: '截图-气泡.png', mimeType: 'image/png', buffer: TINY_PNG })
    await p
      .locator('#task-prompt [data-chip="image"]')
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('图片气泡：附上图片后输入框里没有卡片'))
    // 上传是异步的：草稿里出现带 done 的这张才算传完，不然发出去的是空附件
    await p
      .waitForFunction(
        () =>
          Object.keys(localStorage).some((k) => {
            if (!k.startsWith('chat-attach:')) return false
            try {
              return JSON.parse(localStorage.getItem(k) ?? '[]').some((x) => x.done?.name === '截图-气泡.png')
            } catch {
              return false
            }
          }),
        undefined,
        { timeout: 20000 },
      )
      .catch(() => errors.push('图片气泡：图片没有上传完'))
    await p.locator('#task-prompt').press('Enter')
    // 打开对话页以后输入框换成 #follow-up：等它换掉，再找消息里的卡片（不然会匹配到输入框里那张）
    await p
      .locator('#task-prompt')
      .waitFor({ state: 'detached', timeout: 20000 })
      .catch(() => errors.push('图片气泡：发出后没有打开对话页'))
    const bubble = p.locator('[data-chip="image"][data-name="截图-气泡.png"]')
    await bubble.waitFor({ timeout: 20000 }).catch(() => errors.push('图片气泡：发出去以后消息里没有图片卡片'))
    const chip = await bubble
      .evaluate((el) => {
        const img = el.querySelector('img')
        return {
          src: img?.getAttribute('src') ?? '',
          missing: el.getAttribute('data-missing') === 'true',
          broken: img ? img.naturalWidth === 0 : true,
        }
      })
      .catch(() => null)
    if (!chip) errors.push('图片气泡：消息里的图片卡片读不出来')
    else {
      if (chip.missing) errors.push('图片气泡：附件明明在，卡片却显示成「附件已经不在了」')
      if (!chip.src || chip.broken) errors.push(`图片气泡：缩略图没有显示出来（src=${chip.src || '空'}）`)
    }
    await check(p, '对话-图片气泡')
    // 右上角「⋯」里的「复制对话」：剪贴板里是转录文件的路径，粘贴回输入框变成一张会话卡片，不是一段文字
    await p.getByRole('button', { name: '更多操作' }).first().click()
    await p.getByRole('menuitem', { name: '复制对话' }).click()
    await p
      .getByText('对话已复制，粘贴到输入框会变成一张会话卡片')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('复制对话：没有成功提示'))
    const copied = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (!/\.md\s*$/.test(copied)) errors.push(`复制对话：剪贴板里不是转录文件的路径（${copied || '空'}）`)
    await p.locator('#follow-up').click()
    await p.keyboard.press('Control+V')
    const convChip = p.locator('#follow-up [data-chip="file"]')
    await convChip.waitFor({ timeout: 5000 }).catch(() => errors.push('复制对话：粘贴后输入框里没有出现会话卡片'))
    // 卡片背后要有附件（才能发给 Agent），输入框里不能留着那段路径文字
    const draftText = await p
      .locator('#follow-up')
      .innerText()
      .catch(() => '')
    if (copied.trim() && draftText.includes(copied.trim())) errors.push('复制对话：粘贴后还留着一大段路径文字')
    await check(p, '复制对话-粘贴成卡片')
    // 点开浮层看大图：别等 Playwright 的可点击判定（演示的回复还在流式输出、消息区跟着滚），直接点
    await bubble.evaluate((el) => el.click())
    await p
      .getByRole('dialog')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('图片气泡：点开没有看大图的浮层'))
    const big = await p
      .locator('[role="dialog"] img')
      .first()
      .evaluate((el) => ({ src: el.getAttribute('src') ?? '', broken: el.naturalWidth === 0 }))
      .catch(() => null)
    if (!big || !big.src || big.broken) errors.push('图片气泡：浮层里的大图没有显示出来')
    await check(p, '对话-图片大图')
    await p.keyboard.press('Escape')
    await p.close()
  }

  // 对话里的图片 / 文件路径：点开直接看大图或文件内容；不像路径的行内代码保持原样
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/chat')
    await p.waitForTimeout(900)
    await p.locator('#task-prompt').fill('看看这些文件')
    await p.locator('#task-prompt').press('Enter')
    await p
      .locator('#task-prompt')
      .waitFor({ state: 'detached', timeout: 20000 })
      .catch(() => errors.push('路径可点：发出后没有打开对话页'))
    // 演示的回复是固定的，往这个对话里补一条带路径的回复（回复里出现的路径才是要测的）
    const added = await p.evaluate(() => {
      const key = 'agent-panel-demo-v3'
      const d = JSON.parse(localStorage.getItem(key) ?? '{}')
      const id = decodeURIComponent(location.hash.split('/').pop() ?? '')
      const task = (d.tasks ?? []).find((x) => x.id === id)
      if (!task) return ''
      task.messages.push({
        id: 'demo-paths',
        role: 'agent',
        agentId: task.messages.find((m) => m.role === 'agent')?.agentId ?? '',
        step: '',
        text: [
          '截图：`ui-shots/107-对话-图片气泡.png`',
          '',
          '改的是 `src/App.tsx:7`。',
          '',
          '不是路径的：`console.log`、`1.2.3`、`https://example.com/a.png`',
        ].join('\n'),
        tools: [],
        at: new Date().toISOString(),
      })
      localStorage.setItem(key, JSON.stringify(d))
      return id
    })
    if (!added) errors.push('路径可点：没有找到刚建的对话，补不进回复')
    // 改了 localStorage 必须真的重新加载，页面才读得到新数据
    await p.reload()
    const mdPath = p.locator('code.md-path')
    await mdPath
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => errors.push('路径可点：回复里的路径没有标成能点的'))
    const links = await mdPath.evaluateAll((els) =>
      els.map((el) => ({ text: el.textContent ?? '', tip: el.getAttribute('title') ?? '' })),
    )
    const texts = links.map((l) => l.text)
    if (!texts.includes('ui-shots/107-对话-图片气泡.png'))
      errors.push(`路径可点：中文图片路径没有变成链接（${texts.join('、')}`)
    if (!texts.includes('src/App.tsx:7')) errors.push('路径可点：带行号的文件路径没有变成链接')
    if (links.find((l) => l.text === 'ui-shots/107-对话-图片气泡.png')?.tip !== '查看图片')
      errors.push('路径可点：图片路径的提示不是「查看图片」')
    // 不像路径的行内代码不能变成点了报错的假链接
    const wrong = await p.evaluate(() => {
      const notPath = ['console.log', '1.2.3', 'https://example.com/a.png']
      return [...document.querySelectorAll('code')]
        .filter((el) => notPath.includes(el.textContent ?? '') && el.classList.contains('md-path'))
        .map((el) => el.textContent ?? '')
    })
    if (wrong.length) errors.push(`路径可点：${wrong.join('、')} 不该变成链接`)
    await check(p, '对话-路径可点')
    // 点图片路径：弹出来看大图
    await mdPath
      .filter({ hasText: 'ui-shots/107-对话-图片气泡.png' })
      .first()
      .evaluate((el) => el.click())
    // 图是异步加载的：等它真的画出来再看 naturalWidth，否则拿到的是 0
    await p
      .waitForFunction(
        () => {
          const img = document.querySelector('[role="dialog"] img')
          return !!img && img.complete && img.naturalWidth > 0
        },
        undefined,
        { timeout: 8000 },
      )
      .catch(() => errors.push('路径可点：点开图片路径没有出现图片浮层'))
    const big = await p
      .locator('[role="dialog"] img')
      .first()
      .evaluate((el) => ({ src: el.getAttribute('src') ?? '', width: el.naturalWidth }))
      .catch(() => null)
    if (!big || !big.src || big.width === 0) errors.push('路径可点：图片路径点开后没有显示图片')
    await check(p, '对话-路径-图片大图')
    await p.keyboard.press('Escape')
    // 点文件路径：弹窗里显示文件内容并停在提到的那一行
    await mdPath
      .filter({ hasText: 'src/App.tsx:7' })
      .first()
      .evaluate((el) => el.click())
    const dialog = p.locator('[role="dialog"]')
    await dialog
      .getByText('src/App.tsx:7', { exact: false })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('路径可点：点开文件路径没有打开文件弹窗'))
    // 文件内容是异步读回来的：等第一行出现再断言，不然拿到的是还在转圈的弹窗
    await dialog
      .locator('[data-line]')
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('路径可点：文件弹窗里没有显示文件内容'))
    // 只看文件弹窗里的行号行：消息里那条带行号的代码元素不算（它的行号另有 data-md-line）
    const shown = await dialog
      .evaluate((el) => {
        const rows = [...el.querySelectorAll('[data-line]')]
        const hit = rows.find((r) => r.getAttribute('data-line') === '7')
        return {
          lines: rows.length,
          text: hit?.textContent ?? '',
          marked: hit?.className.includes('bg-accent') ?? false,
        }
      })
      .catch(() => null)
    if (!shown || shown.lines < 5 || !shown.text.includes('return ('))
      errors.push('路径可点：文件弹窗里没有显示文件内容')
    else if (!shown.marked) errors.push('路径可点：文件弹窗没有停在提到的那一行（第 7 行没高亮）')
    await check(p, '对话-路径-文件')
    await p.keyboard.press('Escape')
    await p.close()
  }

  const m = await page({ width: 390, height: 844 })
  await m.goto(base)
  await check(m, '手机-首页', ['今天要做什么'])
  await m.goto(base + '#/workflows')
  await check(m, '手机-工作流')
} catch (e) {
  // CI 里看不到截图时，至少在检查结果的注释里能看到是哪一步、为什么失败
  if (process.env.GITHUB_ACTIONS)
    console.log(`::error title=界面检查::第 ${n} 步之后出错：${String(e?.message ?? e).split('\n')[0]}`)
  throw e
} finally {
  await browser.close()
  server.close()
}

if (errors.length) {
  if (process.env.GITHUB_ACTIONS) for (const e of errors) console.log(`::error title=界面检查::${e.split('\n')[0]}`)
  console.error('\n' + errors.join('\n'))
  process.exit(1)
}
console.log(`\n界面检查通过，截图在 ui-shots/`)
assert.ok(n > 0)
