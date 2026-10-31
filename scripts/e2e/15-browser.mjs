/**
 * 端到端测试分片：正式版前端连真实服务端（假 CLI）在浏览器里走一遍。
 *
 * 界面检查（scripts/ui/）只对在线演示版跑，背后是浏览器里的模拟后端；其余 e2e 分片只走 HTTP、不开浏览器。
 * 所以 web/src/lib/api.ts 和真实服务端之间的接口、SSE 推送，以前从没在浏览器里一起验证过：
 * 字段改名、路由改了，两边各自的检查都是绿的。这个分片补上这一段：
 * 构建正式版前端，用一个小静态服务器托管它并把 /api 原样转给本分片的服务（不加转发头，算本机访问），
 * 打开对话页看回复渲染出来，再从输入框发一句，等第二轮回复也推到页面上。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { runShard } from './harness.mjs'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.json': 'application/json',
}

await runShard('浏览器连真实服务端', async (api) => {
  const { baseUrl, root, call, waitDone, step, setupBase, sleep } = api
  const { project, C } = await setupBase()

  // 正式版前端：构建到临时目录，不碰仓库里的 dist/
  const dist = mkdtempSync(path.join(tmpdir(), 'agent-panel-e2e-dist-'))
  execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist], {
    cwd: root,
    stdio: 'ignore',
  })
  assert.ok(existsSync(path.join(dist, 'index.html')), '前端构建出来了')

  const api0 = new URL(baseUrl)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.startsWith('/api/')) {
      // 原样转发（包括 SSE 长连接）；Host 换成服务自己的，和浏览器直接打开服务时一样
      const up = http.request(
        {
          host: api0.hostname,
          port: api0.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: api0.host },
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers)
          r.pipe(res)
        },
      )
      up.on('error', () => res.destroy())
      req.pipe(up)
      return
    }
    const p = decodeURIComponent(url.pathname)
    const f = path.join(dist, p === '/' ? 'index.html' : p)
    const file = f.startsWith(dist) && existsSync(f) && !f.endsWith(path.sep) ? f : path.join(dist, 'index.html')
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
    res.end(readFileSync(file))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const site = `http://127.0.0.1:${server.address().port}`
  const exe = process.env.CHROMIUM_PATH
  const browser = await chromium.launch(exe ? { executablePath: exe } : {})
  try {
    const errors = []
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 860 } })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(`页面出错：${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error' && m.location().url.startsWith(site)) errors.push(`控制台错误：${m.text()}`)
    })

    let chat = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: C.id,
      prompt: '介绍一下自己',
    })
    chat = await waitDone(chat.id)
    const reply = (t) =>
      [...t.messages]
        .reverse()
        .find((m) => m.role !== 'user' && m.text.trim())
        ?.text.trim() ?? ''
    const first = reply(await call('GET', `/tasks/${chat.id}`))
    assert.ok(first, '假 CLI 回了内容')

    await page.goto(`${site}/#/projects/${encodeURIComponent(project.id)}/${encodeURIComponent(chat.id)}`)
    await page.getByText(first.slice(0, 20)).first().waitFor({ timeout: 20_000 })
    assert.equal(await page.getByRole('alert').filter({ hasText: '连不上面板服务' }).count(), 0, '没有误报断开')
    step('正式版前端打开真实服务端上的对话：回复渲染出来，没有断开提示')

    // 从输入框发一句：走真实的 POST /messages 和 SSE 推送，第二轮回复出现在页面上
    const input = page.locator('#follow-up').first()
    await input.click()
    await input.fill('再说一点')
    await input.press('Enter')
    // 对话回复完会停在「等下一句」，状态仍是 running：按「第二条用户消息之后有了回复」判这一轮做完
    let second = ''
    for (let i = 0; i < 200 && !second; i++) {
      const cur = await call('GET', `/tasks/${chat.id}`)
      const at = cur.messages.findLastIndex((m) => m.role === 'user')
      const after = cur.messages.slice(at + 1).find((m) => m.role !== 'user' && m.text.trim())
      if (cur.messages.filter((m) => m.role === 'user').length >= 2 && after) second = after.text.trim()
      else await sleep(100)
    }
    assert.ok(second, '第二轮执行完了')
    await page.getByText('再说一点').first().waitFor({ timeout: 10_000 })
    await page.getByText(second.slice(0, 20)).last().waitFor({ timeout: 20_000 })
    assert.deepEqual(errors, [], '浏览器里没有报错')
    step('在页面输入框里发消息：真实接口收下、执行，回复经 SSE 推到页面')
  } finally {
    await browser.close()
    server.close()
  }
})
