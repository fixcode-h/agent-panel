/**
 * 端到端测试：用临时数据目录启动服务，把三个 CLI 都指向 scripts/fake-cli/fake-cli.mjs，
 * 走一遍设置 → 检测 → 工作流任务（含并行阶段）→ 追加要求（续接会话）→ 对话任务 → 停止 → 失败 → 找不到命令 → 停用。
 *
 * 运行：npm run test:e2e（需要 git；假 CLI 依赖 shebang 和 /bin/sh，只能在 macOS / Linux 上跑）
 */
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

// 假 CLI 靠 shebang 直接执行，脚本里也用 mkdir -p、tar 这类 Unix 命令：
// Windows 上先给出能照着做的提示，不要跑到一半才报一堆看不懂的错
if (process.platform === 'win32') {
  console.error(
    '端到端测试请在 WSL / macOS / Linux 上运行（Windows 上可以在 WSL 里装好依赖后跑 `npm run test:e2e:wsl`）。',
  )
  process.exit(1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fake = path.join(root, 'scripts/fake-cli/fake-cli.mjs')
const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-e2e-'))
const dataDir = path.join(tmp, 'data')
const homeDir = path.join(tmp, 'home')
mkdirSync(homeDir, { recursive: true })
const projectDir = path.join(tmp, 'project')
const log = path.join(tmp, 'calls.jsonl')
const port = 8900 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}/api`
// 1×1 的透明 PNG，用来测图片文件按原图读取
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

// 项目目录：一个已有提交、并且有一处未提交改动的 git 仓库
mkdirSync(projectDir, { recursive: true })
const git = (...a) => execFileSync('git', a, { cwd: projectDir, stdio: 'pipe' })
/** 在别的目录（任务的独立分支目录）里跑 git */
const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' })
git('init', '-q')
writeFileSync(path.join(projectDir, 'README.md'), '# demo\n')
writeFileSync(path.join(projectDir, 'pre.txt'), 'old\n')
git('add', '.')
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
writeFileSync(path.join(projectDir, 'pre.txt'), 'changed before the task\n')

// 假的 GitHub Releases：三个版本，包是现做的 tar.gz，用来测试设置里的版本更新
const appDir = path.join(tmp, 'app')
const relDir = path.join(tmp, 'releases')
mkdirSync(path.join(appDir, 'dist'), { recursive: true })
mkdirSync(path.join(appDir, 'data'), { recursive: true })
mkdirSync(relDir, { recursive: true })
writeFileSync(path.join(appDir, 'server.mjs'), '// old\n')
writeFileSync(path.join(appDir, 'dist/old.html'), 'old')
writeFileSync(path.join(appDir, 'data/keep.json'), '{"keep":true}')
// Windows 托盘程序：上次更新挪开的 AgentPanel.exe.old 还在运行，删不掉也不能被覆盖（这里用非空目录模拟）
writeFileSync(path.join(appDir, 'AgentPanel.exe'), 'tray-old')
mkdirSync(path.join(appDir, 'AgentPanel.exe.old'), { recursive: true })
writeFileSync(path.join(appDir, 'AgentPanel.exe.old', 'busy'), '')
for (const v of ['0.11.9-dev', '0.11.8', '0.11.4']) {
  const d = path.join(relDir, `agent-panel-${v}`)
  mkdirSync(path.join(d, 'dist'), { recursive: true })
  // 0.11.8 的服务端加载就出错：更新时试跑不通过，要退回原来的版本
  writeFileSync(path.join(d, 'server.mjs'), v === '0.11.8' ? 'process.exit(3)\n' : `// new ${v}\n`)
  writeFileSync(path.join(d, 'dist/index.html'), `<p>${v}</p>`)
  writeFileSync(path.join(d, 'start.sh'), '#!/bin/sh\n')
  writeFileSync(path.join(d, 'AgentPanel.exe'), `tray-${v}`)
  execFileSync('tar', ['-czf', `${d}.tar.gz`, `agent-panel-${v}`], { cwd: relDir })
  // 校验文件：0.11.4 的哈希故意写错
  const hash = createHash('sha256')
    .update(readFileSync(`${d}.tar.gz`))
    .digest('hex')
  writeFileSync(`${d}.sums`, `${v === '0.11.4' ? '0'.repeat(64) : hash}  agent-panel-${v}.tar.gz\n`)
}
// 旧版本平铺的数据文件，启动时应搬进 config/
mkdirSync(dataDir, { recursive: true })
writeFileSync(path.join(dataDir, 'project-categories.json'), '[]')
// 旧版本把所有任务放在一个 tasks.json 里，启动后拆成每个任务一个文件
const legacyAt = '2026-10-01T00:00:00.000Z'
writeFileSync(
  path.join(dataDir, 'tasks.json'),
  JSON.stringify([
    {
      id: 'legacy-1',
      projectId: 'legacy-project',
      title: '旧任务',
      mode: 'chat',
      status: 'done',
      messages: [{ id: 'm1', role: 'user', text: '旧的要求', at: legacyAt }],
      createdAt: legacyAt,
      updatedAt: legacyAt,
    },
  ]),
)
// 上一版每个任务一个完整文件（tasks/items/），启动后按项目分目录、对话单独存
mkdirSync(path.join(dataDir, 'tasks/items'), { recursive: true })
writeFileSync(
  path.join(dataDir, 'tasks/items/legacy-2.json'),
  JSON.stringify({
    id: 'legacy-2',
    projectId: '',
    title: '旧聊天',
    mode: 'chat',
    status: 'done',
    messages: [
      { id: 'm1', role: 'user', text: '旧的聊天', at: legacyAt },
      { id: 'm2', role: 'agent', text: '旧的回答', at: legacyAt },
    ],
    createdAt: legacyAt,
    updatedAt: legacyAt,
  }),
)
const relServer = http.createServer((req, res) => {
  const host = `http://127.0.0.1:${relServer.address().port}`
  if (req.url.startsWith('/releases')) {
    res.setHeader('content-type', 'application/json')
    const rel = (v, pre, day) => ({
      tag_name: `v${v}`,
      prerelease: pre,
      draft: false,
      published_at: `2026-10-${day}T00:00:00Z`,
      body: `## 新功能\n- **${v}** — 说明`,
      html_url: `${host}/r/${v}`,
      assets: [
        { name: `agent-panel-${v}.tar.gz`, browser_download_url: `${host}/dl/agent-panel-${v}.tar.gz`, size: 100 },
        { name: `agent-panel-${v}.zip`, browser_download_url: `${host}/dl/agent-panel-${v}.zip`, size: 100 },
        { name: 'SHA256SUMS', browser_download_url: `${host}/dl/agent-panel-${v}.sums`, size: 100 },
      ],
    })
    res.end(JSON.stringify([rel('0.11.9-dev', true, 16), rel('0.11.8', false, 15), rel('0.11.4', false, 10)]))
  } else if (req.url.startsWith('/dl/') && existsSync(path.join(relDir, req.url.slice(4)))) {
    res.end(readFileSync(path.join(relDir, req.url.slice(4))))
  } else {
    res.statusCode = 404
    res.end()
  }
})
await new Promise((r) => relServer.listen(0, '127.0.0.1', r))

const server = spawn(path.join(root, 'node_modules/.bin/tsx'), ['server/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    AGENT_PANEL_DATA: dataDir,
    // 断言按空数据写的，不装内置工作流和 Agent（单元测试里单独测）
    // 账号测试会读写 CLI 的凭据文件：用临时的用户目录，不碰真正的 ~/.claude、~/.codex
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: '',
    CODEX_HOME: '',
    GEMINI_CLI_HOME: '',
    // 断言里用的是中文提示，固定用中文界面跑
    LANG: 'zh_CN.UTF-8',
    PORT: String(port),
    FAKE_CLI_LOG: log,
    AGENT_PANEL_NPM: path.join(root, 'scripts/fake-cli/fake-npm.mjs'),
    AGENT_PANEL_RELEASES_URL: `http://127.0.0.1:${relServer.address().port}/releases`,
    AGENT_PANEL_APP_DIR: appDir,
    AGENT_PANEL_VERSION: '0.11.5',
    AGENT_PANEL_NO_RESTART: '1',
    // 空闲超时按「分钟」设置，测试里一分钟只算 1.5 秒
    AGENT_PANEL_MINUTE_MS: '1500',
    AGENT_PANEL_REDIRECT_MS: '600',
    // 对话页切走后的宽限也缩短，测试不用等一分钟
    AGENT_PANEL_PRESENCE_GRACE_MS: '1200',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
/**
 * 退出前要收尾的资源：临时起的 server、子进程。都登记进来，断言失败时统一关掉。
 * 不登记的话，没关的 server 会一直占着事件循环，进程明明已经失败却不退出，CI 会挂到超时才结束
 */
const cleanups = new Set()
const onExit = (fn) => {
  cleanups.add(fn)
  // 返回值可以立刻关掉这个资源，同时从登记表里去掉，退出时不会再关第二次
  return () => {
    if (!cleanups.delete(fn)) return
    fn()
  }
}
const cleanupAll = () => {
  // 后起的先关（临时 server 可能依赖先起的那几个）
  for (const fn of [...cleanups].reverse()) {
    cleanups.delete(fn)
    try {
      fn()
    } catch {}
  }
}
onExit(() => server.kill())
// close() 只是停止接受新连接，已经建好的 keep-alive 连接会一直挂着（进程因此退不出去），
// 所以先把它们断掉再关
onExit(() => {
  relServer.closeAllConnections()
  relServer.close()
})
process.on('exit', cleanupAll)
// 主流程之外抛出的错误（后台 promise、写文件失败）也走同一套收尾，不要留下半开的服务
const fail = (e) => {
  console.error(e)
  process.exitCode = 1
  cleanupAll()
  process.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

const call = async (method, url, body) => {
  // 下面大部分用例测的是按连线自动执行（每次调用的顺序、提示词都按这个断言）；没有编排器的那条单独写明 dispatch: true
  if (
    (method === 'POST' || method === 'PUT') &&
    /^\/workflows(\/[^/]+)?$/.test(url) &&
    body &&
    body.dispatch === undefined
  )
    body = { ...body, dispatch: false }
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  const j = r.status === 204 ? null : await r.json()
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(j)}`)
  return j
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitDone(id, timeout = 20000) {
  const t0 = Date.now()
  for (;;) {
    const t = await call('GET', `/tasks/${id}`)
    if (t.status !== 'running') return t
    if (Date.now() - t0 > timeout) throw new Error(`任务 ${id} 超时仍在执行`)
    await sleep(150)
  }
}
/** 等到条件成立（任务停下且 ok(t) 为真）：开独立分支后面板会马上接着开下一轮，中间可能短暂停下 */
async function waitTask(id, ok, timeout = 30000) {
  const t0 = Date.now()
  for (;;) {
    const t = await call('GET', `/tasks/${id}`)
    if (t.status !== 'running' && ok(t)) return t
    if (Date.now() - t0 > timeout) throw new Error(`任务 ${id} 超时：${t.status}`)
    await sleep(150)
  }
}
const readLog = (f) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : []
const calls = () => {
  const ends = new Map(readLog(`${log}.end`).map((e) => [e.pid, e.end]))
  return readLog(log).map((c) => ({ ...c, end: ends.get(c.pid) }))
}
// 看门狗：某一步卡住（等一个永远不返回的请求）时打印最后完成的步骤并失败退出，
// 别让一整轮 e2e 把 CI 拖到 workflow 的超时
const WATCHDOG_MS = Number(process.env.AGENT_PANEL_E2E_WATCHDOG_MS ?? 10 * 60_000)
let lastStep = '启动服务'
const step = (name) => {
  lastStep = name
  console.log(`✓ ${name}`)
}
const watchdog = setTimeout(() => {
  console.error(`端到端测试超过 ${Math.round(WATCHDOG_MS / 60000)} 分钟没有跑完，最后完成：${lastStep}`)
  cleanupAll()
  process.exit(1)
}, WATCHDOG_MS)

for (let i = 0; ; i++) {
  try {
    await call('GET', '/health')
    break
  } catch {
    if (i > 100) throw new Error('服务没有启动')
    await sleep(100)
  }
}

try {
  // 新装：所有 CLI 都先不启用，等用户自己去设置里打开
  const fresh = await call('GET', '/settings')
  assert.ok(
    Object.values(fresh.clis).length && Object.values(fresh.clis).every((c) => !c.enabled),
    '新装时 CLI 默认不启用',
  )
  assert.ok((await call('GET', '/clis')).every((c) => !c.enabled))
  step('新装时 CLI 默认都不启用')

  const cli = (extra = {}) => ({
    enabled: true,
    command: fake,
    defaultModel: '',
    permission: '',
    extraArgs: [],
    env: [{ key: 'FOO', value: 'bar' }],
    ...extra,
  })
  const settings = {
    stepTimeoutMinutes: 5,
    clis: { claude: cli({ defaultModel: 'sonnet' }), codex: cli(), commandcode: cli(), gemini: cli(), pi: cli() },
  }
  await call('PUT', '/settings', settings)
  const clis = await call('GET', '/clis?refresh=1')
  assert.deepEqual(
    clis.map((c) => [c.id, c.installed]),
    [
      ['claude', true],
      ['codex', true],
      ['commandcode', true],
      ['gemini', true],
      ['pi', true],
    ],
  )
  assert.match(clis[1].version, /fake 0.0.1/)
  step('设置保存，各个 CLI 都能检测到')

  const agent = (o) =>
    call('POST', '/agents', {
      description: '',
      model: '',
      icon: 'bot',
      categoryId: '',
      instructions: '',
      extraArgs: [],
      enabled: true,
      ...o,
    })
  const A = await agent({ name: '甲', cli: 'claude', instructions: '你是甲，负责规划。' })
  const B = await agent({ name: '乙', cli: 'codex', model: 'gpt-5.6', instructions: '你是乙，负责实现。' })
  const C = await agent({ name: '丙', cli: 'commandcode', extraArgs: ['--effort', 'low'] })
  {
    // 引入会绕回自己时拒绝保存；引入自己的直接去掉
    const put = (a, o) =>
      fetch(`${base}/agents/${a.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...a, ...o }),
      })
    assert.equal((await put(A, { includes: [B.id, A.id] })).status, 200)
    assert.deepEqual((await call('GET', '/agents')).find((a) => a.id === A.id).includes, [B.id])
    const r = await put(B, { includes: [A.id] })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /循环：乙 → 甲 → 乙/)
    assert.equal((await put(A, { includes: [] })).status, 200)
    step('Agent 引入：会形成循环的拒绝保存')
  }
  const node = (id, title, agentId, instructions, more = {}) => ({
    id,
    title,
    agentId,
    instructions,
    x: 0,
    y: 0,
    ...more,
  })
  let eid = 0
  const edges = (...pairs) => pairs.map(([from, to]) => ({ id: `e${++eid}`, from, to }))
  const flow = (id, name, nodes, es) => ({ id, name, nodes, edges: edges(...es) })
  const wf = await call('POST', '/workflows', {
    name: '三阶段',
    description: '',
    mainAgentId: A.id,
    members: [
      { agentId: B.id, responsibility: '' },
      { agentId: C.id, responsibility: '' },
    ],
    flows: [
      flow(
        'main',
        '主流程',
        [
          node('n1', '分析', '', '先分析。'),
          node('n2', '实现', B.id, '写代码。'),
          node('n3', '文档', C.id, '写文档。'),
          node('n4', '验收', '', '检查结果。'),
          node('n5', '没连上', '', ''),
        ],
        [
          ['start', 'n1'],
          ['n1', 'n2'],
          ['n1', 'n3'],
          ['n2', 'n4'],
          ['n3', 'n4'],
          ['n4', 'end'],
        ],
      ),
    ],
    entryFlowId: 'main',
    document: '# 目标\n测试\n',
  })
  const project = await call('POST', '/projects', {
    name: '测试项目',
    description: '',
    path: projectDir,
    categoryId: '',
    workflowId: wf.id,
    // 下面大部分子对话的测试按共用目录写；独立 worktree 有单独的测试
    childIsolation: 'claim',
  })

  // ---- 工作流任务 ----
  let t = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '做一个新功能' })
  assert.equal(t.status, 'running')
  t = await waitDone(t.id)
  assert.equal(t.status, 'done', JSON.stringify(t.messages.filter((m) => m.role === 'system')))
  assert.equal(t.simulated, false)
  assert.deepEqual(
    t.steps.map((s) => [s.id, s.status]),
    [
      ['n1', 'done'],
      ['n2', 'done'],
      ['n3', 'done'],
      ['n4', 'done'],
    ],
    '没连到开始的节点不执行',
  )
  assert.ok(t.steps.every((s) => s.startedAt && s.endedAt))
  for (const who of [A, B, C])
    assert.ok(
      t.messages.some((m) => m.agentId === who.id && m.text.includes('的回复')),
      `${who.name} 没有输出文字`,
    )
  const kinds = new Set(t.messages.flatMap((m) => m.tools.map((x) => x.kind)))
  for (const k of ['read', 'edit', 'run']) assert.ok(kinds.has(k), `缺少工具类型 ${k}`)
  // 工作流的节点都用默认 CLI（Claude Code）的档位执行，不看 Agent 自己选的 CLI
  const changed = t.changes.map((c) => c.path).sort()
  assert.deepEqual(changed, ['claude-output.txt'])
  assert.deepEqual(Object.keys(t.sessions).sort(), ['n1', 'n2', 'n3', 'n4'], '每个节点各有自己的会话')
  assert.equal(Object.keys(t.usage.agents).length, 3)
  assert.equal(t.usage.agents[A.id].context, 13020)
  assert.ok(Math.abs(t.usage.costUsd - 0.0123 * 4) < 1e-9)
  // 用量：输入含缓存，缓存命中单独记；流式过程中计入的和最后的总数不重复。四个节点各 25530 输入（25000 命中、500 写入）
  assert.equal(t.usage.inputTokens, 25530 * 4)
  assert.equal(t.usage.cacheReadTokens, 25000 * 4)
  assert.equal(t.usage.cacheWriteTokens, 500 * 4)
  assert.equal(t.usage.outputTokens, 120 * 4)
  assert.equal(t.usage.agents[B.id].window, 500000, 'Claude Code 在 result.modelUsage 里报告的上下文窗口')
  // 每个节点自己的用量和改动：加起来等于任务的
  assert.equal(
    t.steps.reduce((n, s) => n + (s.usage?.inputTokens ?? 0), 0),
    t.usage.inputTokens,
  )
  const codexStep = t.steps.find((s) => s.agentId === B.id)
  assert.equal(codexStep.usage.context, 13020)
  // 节点的命令：默认 CLI、Agent 档位对应的模型；固定了别的 CLI 的 Agent，它的额外参数不带过去
  assert.ok(
    t.steps.every((s) => s.command.includes('--model') && s.command[s.command.indexOf('--model') + 1] === 'sonnet'),
  )
  assert.ok(
    !t.steps.find((s) => s.agentId === C.id).command.includes('low'),
    '丙的 Command Code 参数不带给 Claude Code',
  )
  assert.ok(
    Object.values(t.usage.agents).every((u) => u.tps === 0),
    '结束后速度归零',
  )
  // 思考过程记在回复上
  for (const who of [A, B, C])
    assert.ok(
      t.messages.some((m) => m.agentId === who.id && m.thinking),
      `${who.name} 的思考没有记录`,
    )
  // 待办：Claude 的 TodoWrite
  assert.deepEqual(
    t.todos.filter((x) => x.agentId === A.id).map((x) => [x.text, x.status]),
    [
      ['读代码', 'done'],
      ['正在写文件', 'running'],
    ],
  )
  step('工作流任务：按连线执行，输出、工具、改动（排除任务前的改动）、用量都正确')

  // 列表只给摘要；任务页靠推送（SSE）拿增量，合起来和完整任务一致
  const summary = (await call('GET', '/tasks')).find((x) => x.id === t.id)
  assert.equal(summary.messages.length, 1, '列表里只有第一条要求')
  assert.ok(
    summary.steps.every((s) => s.output === '' && s.command.length === 0),
    '列表里不带节点输出',
  )
  {
    const live = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '推送测试' })
    const res = await fetch(`${base}/tasks/${live.id}/events`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let view = null
    let patches = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(block)?.[1]
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n')
        if (ev === 'full') view = JSON.parse(data)
        else if (ev === 'patch') {
          patches++
          const p = JSON.parse(data)
          const msgs = view.messages.slice()
          for (const m of p.messages) {
            const k = msgs.findIndex((x) => x.id === m.id)
            if (k >= 0) msgs[k] = m
            else msgs.push(m)
          }
          view = { ...p.meta, messages: msgs }
          assert.equal(msgs.length, p.total)
        }
      }
      if (view && view.status !== 'running') break
    }
    await reader.cancel()
    assert.ok(patches > 0, '执行过程中推送了增量')
    const final = await call('GET', `/tasks/${live.id}`)
    assert.equal(view.status, final.status)
    assert.deepEqual(
      view.messages.map((m) => [m.id, m.text]),
      final.messages.map((m) => [m.id, m.text]),
      '增量合起来和完整任务一致',
    )
  }
  // 归档：只是打个标记，列表里带着，取消归档后恢复
  const arch = await call('PATCH', `/tasks/${t.id}`, { archived: true })
  assert.equal(arch.archived, true)
  assert.equal((await call('GET', '/tasks')).find((x) => x.id === t.id).archived, true)
  await call('PATCH', `/tasks/${t.id}`, { archived: false })
  step('任务列表只给摘要，任务页通过推送拿增量；可以归档')

  // 任务存下创建时的工作流：之后改了工作流，老任务的记录不变；继续执行时可以选择改用新的
  {
    assert.equal(t.workflows[0]?.id, wf.id, '任务存下了工作流')
    assert.equal(summary.workflowName, wf.name, '列表里有工作流名字')
    const cur = await call('GET', `/workflows`).then((l) => l.find((x) => x.id === wf.id))
    const { id, createdAt, updatedAt, ...input } = cur
    const renamed = {
      ...input,
      flows: input.flows.map((f) => ({ ...f, nodes: f.nodes.map((n) => ({ ...n, title: `${n.title}（新）` })) })),
    }
    await call('PUT', `/workflows/${wf.id}`, renamed)
    const again = await call('GET', `/tasks/${t.id}`)
    assert.ok(!again.workflows[0].flows[0].nodes.some((n) => n.title.endsWith('（新）')), '老任务的工作流不跟着改')
    await call('PUT', `/workflows/${wf.id}`, input)
  }
  step('任务存下创建时的工作流，之后改工作流不影响老任务')

  let c = calls()
  const [c1, cp1, cp2, c4] = c
  assert.equal(c1.kind, 'claude')
  assert.equal(c1.cwd, projectDir)
  assert.ok(c1.args.includes('--append-system-prompt') && c1.args.includes('你是甲，负责规划。'))
  assert.ok(c1.args.includes('--model') && c1.args.includes('sonnet'), 'Agent 没写模型时应使用设置里的默认模型')
  assert.ok(c1.args.includes('--permission-mode') && c1.args.includes('acceptEdits'))
  assert.match(c1.input, /流程「主流程」的节点：分析/)
  assert.match(c1.input, /## 本节点要做的事\n先分析。/)
  assert.doesNotMatch(c1.input, /同时进行的节点/)
  // 节点都用默认 CLI：乙（固定 Codex）、丙（固定 Command Code）的节点也交给 Claude Code
  const c2 = [cp1, cp2].find((x) => x.input.includes('节点：实现'))
  const c3 = [cp1, cp2].find((x) => x.input.includes('节点：文档'))
  assert.ok(c2 && c3 && c2.kind === 'claude' && c3.kind === 'claude', '节点固定用默认 CLI')
  assert.ok(c2.start < c3.end && c3.start < c2.end, '同一阶段的两个节点应该同时运行')
  assert.ok(Math.min(c2.start, c3.start) >= c1.end, '下游节点要等上游结束')
  assert.ok(c4.start >= Math.max(c2.end, c3.end), '有两个上游的节点要等两个都结束')
  assert.ok(c2.args.includes('你是乙，负责实现。'), '角色设定照样交给默认 CLI')
  assert.match(c2.input, /上游节点的结果[\s\S]*### 分析/)
  assert.match(c2.input, /同时进行的节点[\s\S]*文档（丙）/)
  assert.match(c3.input, /同时进行的节点[\s\S]*实现（乙）/)
  assert.ok(!c3.args.includes('low'), '丙写给 Command Code 的额外参数不带给 Claude Code')
  assert.equal(c4.kind, 'claude')
  assert.match(c4.input, /上游节点的结果[\s\S]*### 实现[\s\S]*### 文档/)
  assert.ok(!c4.args.includes('--resume'), '不同节点用各自的新会话')
  // 对话还是用 Agent 自己的 CLI：乙用 Codex，丙用 Command Code
  {
    const n0 = calls().length
    let ct = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '看看代码' })
    ct = await waitDone(ct.id)
    assert.equal(ct.status, 'done')
    const cx = calls()
      .slice(n0)
      .find((x) => x.kind === 'codex')
    assert.ok(cx, '对话用 Agent 自己的 CLI')
    assert.equal(cx.developer, '你是乙，负责实现。', 'Codex 的角色说明通过 developerInstructions 传入')
    assert.ok(!cx.input.includes('## 你的角色'))
    // AI 第一次回复后按对话内容自动起标题（换掉从消息截的那段），只起一次
    let named = ''
    for (let i = 0; i < 100 && !named; i++) {
      const x = await call('GET', `/tasks/${ct.id}`)
      if (x.title !== '看看代码') named = x.title
      else await sleep(100)
    }
    assert.equal(named, '看看代码·AI', 'AI 回复后自动起了标题')
    assert.equal((await call('GET', `/tasks/${ct.id}`)).autoTitle, false, '一个对话只起一次标题')
    assert.equal(cx.args[0], 'app-server', 'Codex 用 app-server 执行才有流式输出')
    assert.ok(cx.args.includes('model="gpt-5.6"'))
    assert.ok(cx.args.includes('approval_policy="on-request"'), '参数里的确认方式和 thread/start 一致')
    assert.deepEqual(
      [cx.approval, cx.sandbox],
      ['on-request', 'workspace-write'],
      '可写项目目录：沙箱内运行，越过沙箱时确认',
    )
    await call('DELETE', `/tasks/${ct.id}`)
    const n1 = calls().length
    let cc = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: C.id, prompt: '写文档' })
    cc = await waitDone(cc.id)
    const cm = calls()
      .slice(n1)
      .find((x) => x.kind === 'commandcode')
    assert.ok(cm && cm.args.includes('--effort') && cm.args.includes('low'))
    await call('DELETE', `/tasks/${cc.id}`)
  }
  step('调用参数：模型、权限、角色设定、上游结果、同时进行的节点、工作目录都对；没有依赖的节点同时运行')

  // 上游的结果太长：交给下游的只放开头，完整内容存成文件，下游的 CLI 能读到那个目录
  const nLong = calls().length
  let tLong = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'LONGOUT 写个详细方案' })
  tLong = await waitDone(tLong.id)
  assert.equal(tLong.status, 'done')
  const down = calls()
    .slice(nLong)
    .find((x) => x.input.includes('节点：实现'))
  const handoff = /完整内容在文件 (\S+?\.md)/.exec(down.input)?.[1]
  assert.ok(handoff && existsSync(handoff), '下游拿到完整结果的文件路径 ' + down.input.slice(-300))
  assert.ok(readFileSync(handoff, 'utf8').includes('很长的方案。'.repeat(1000) + '结尾'), '文件里是完整结果')
  assert.ok(!down.input.includes('结尾'), '提示里只放开头')
  const cLong = calls()
    .slice(nLong)
    .find((x) => x.kind === 'claude' && x.input.includes('上游节点的结果'))
  assert.ok(cLong.args.includes(path.dirname(handoff)), 'Claude Code 能读交接文件的目录')
  await call('DELETE', `/tasks/${tLong.id}`)
  assert.ok(!existsSync(path.dirname(handoff)), '删除任务时删掉交接文件')
  step('节点交接：上游结果太长时完整内容存成文件，下游按路径去读')

  // ---- 追加要求：主 Agent 续接会话 ----
  await call('POST', `/tasks/${t.id}/messages`, { text: '按钮改成红色' })
  t = await waitDone(t.id)
  assert.equal(t.status, 'done')
  c = calls().at(-1)
  assert.equal(c.kind, 'claude')
  assert.ok(
    c.args.includes('--resume') && c.args.includes(t.sessions.n4),
    '追加要求应该续接主 Agent 最后执行的节点的会话',
  )
  assert.equal(t.sessions[A.id], t.sessions.n4)
  assert.match(c.input, /按钮改成红色/)
  step('追加要求：由主 Agent 续接会话处理')

  // ---- 对话任务 ----
  let chat = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    prompt: '解释一下项目结构',
  })
  chat = await waitDone(chat.id)
  assert.equal(chat.status, 'done')
  // 对话提示由「用户这次的消息」和授权、工作流、执行方式等几段拼成，任务描述在最前面
  assert.match(calls().at(-1).input, /^## 用户这次的消息\n解释一下项目结构\n\n/, '任务描述在对话提示的开头')
  await call('POST', `/tasks/${chat.id}/messages`, { text: '继续' })
  chat = await waitDone(chat.id)
  c = calls().at(-1)
  assert.ok(c.args.includes('--resume') && c.args.includes(chat.sessions[C.id]))
  step('对话任务：直接发给选中的 Agent，继续对话会续接会话')

  // ---- 不用角色：直接用默认 CLI（以前的「默认 Agent」去掉了） ----
  const allAgents = await call('GET', '/agents')
  assert.ok(!allAgents.some((x) => x.id === 'default-agent'), '不再有自带的默认 Agent')
  const def = { id: '' }
  let dc = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: def.id, prompt: '默认' })
  dc = await waitDone(dc.id)
  c = calls().at(-1)
  assert.equal(c.kind, 'claude')
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'sonnet', '用默认 CLI 的默认模型')
  assert.ok(dc.runMs > 0 && !dc.runStartedAt, '记下执行时间')
  dc = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    model: 'claude-opus-5-5',
    effort: 'high',
    prompt: '换模型',
  })
  dc = await waitDone(dc.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-opus-5-5', '对话时临时换的模型')
  assert.equal(c.args[c.args.indexOf('--effort') + 1], 'high')
  await call('POST', `/tasks/${dc.id}/messages`, { text: '继续' })
  await waitDone(dc.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-opus-5-5', '继续对话也用临时换的模型')
  // 对话时选别的 CLI：默认 Agent 换成那个 CLI 执行，继续对话也用它
  dc = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'codex',
    prompt: '换 CLI',
  })
  assert.equal(dc.cli, 'codex')
  dc = await waitDone(dc.id)
  assert.equal(dc.status, 'done', dc.messages.at(-1)?.text)
  assert.equal(calls().at(-1).kind, 'codex', '对话时选的 CLI')
  await call('POST', `/tasks/${dc.id}/messages`, { text: '继续' })
  await waitDone(dc.id)
  assert.equal(calls().at(-1).kind, 'codex', '继续对话也用选的 CLI')
  // Gemini CLI：按配置文件（shared/clis/gemini.json）拼参数、解析 stream-json
  let gm = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'gemini',
    prompt: '用 Gemini',
  })
  gm = await waitDone(gm.id)
  assert.equal(gm.status, 'done', gm.messages.at(-1)?.text)
  c = calls().at(-1)
  assert.equal(c.kind, 'gemini')
  assert.ok(c.args.includes('--approval-mode') && c.args.includes('auto_edit'), c.args.join(' '))
  assert.match(c.input, /^## 用户这次的消息\n用 Gemini\n\n/, '任务描述从 stdin 传入')
  const gReply = gm.messages.filter((m) => m.role === 'agent').at(-1)
  assert.match(gReply.text, /这是 gemini 的回复/)
  assert.deepEqual(
    gReply.tools.map((x) => x.kind),
    ['read', 'edit'],
    '工具调用按名字认出读文件、改文件',
  )
  assert.equal(gm.usage.inputTokens, 5000, JSON.stringify(gm.usage))
  await call('POST', `/tasks/${gm.id}/messages`, { text: '继续' })
  await waitDone(gm.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--resume') + 1], gm.sessions[gm.agentId], '继续时续接会话')
  // 空回合：模型只回一句「我先…」就收尾（零工具、零改动），面板要先把这件事写进对话再自动接一轮；
  // 接上之后模型正常交结果，那条报错卡片要收成普通说明，不能一直挂成失败
  let emp = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'claude',
    prompt: 'FAKE_EMPTY 看一下这个项目',
  })
  emp = await waitDone(emp.id)
  assert.equal(emp.status, 'done', emp.messages.at(-1)?.text)
  const empNotes = emp.messages.filter((m) => m.role === 'system' && !m.step)
  const empNote = empNotes.find((m) => /只回了一句话就结束了/.test(m.text))
  assert.ok(
    empNote,
    `自动接一轮要可见；现有消息：${JSON.stringify(
      emp.messages.map((x) => [x.role, x.step, x.transient ?? false, x.error ?? false, x.text.slice(0, 30)]),
    )}`,
  )
  assert.ok(!empNote.error, '接上之后不能还挂着红色错误卡片')
  assert.match(empNote.text, /已自动接一轮，这一轮继续做完了/, '写明已经接一轮做完了')
  const empAgent = emp.messages.filter((m) => m.role === 'agent')
  assert.equal(empAgent.length, 2, '第一轮只说了一句 + 催促后的一轮')
  assert.match(empAgent[0].text, /我先把工作区更新到最新/)
  assert.match(empAgent[1].text, /这是 claude 的回复/, '被催之后正常交了结果')

  // 同一件事走常驻保活的 CLI（Command Code）：回复完会先进入 keepAlive 等下一句，
  // 一挂起 runAgent 就不返回，收尾处的空回合兜底没机会跑。必须在保活前判定，命中就不保活。
  let empKeep = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'commandcode',
    askUser: false,
    prompt: 'FAKE_EMPTY 确认一下保活下的空回合',
  })
  await call('POST', `/tasks/${empKeep.id}/seen`, {})
  await call('POST', `/tasks/${empKeep.id}/presence`, { viewerId: 'e2e-empty', active: true })
  // 这个 CLI 回复完会停在等下一句上（保活），任务状态一直算执行中，不能等 status；按消息判断
  const empKeepDone = () =>
    empKeep.messages.some((m) => m.role === 'system' && /只回了一句话就结束了/.test(m.text)) &&
    empKeep.messages.filter((m) => m.role === 'agent').length >= 2
  for (let i = 0; i < 200 && !empKeepDone(); i++) {
    await sleep(150)
    empKeep = await call('GET', `/tasks/${empKeep.id}`)
  }
  assert.ok(
    empKeep.messages.some((m) => m.role === 'system' && /只回了一句话就结束了/.test(m.text)),
    `保活路径下也要自动接一轮；现有消息：${JSON.stringify(
      empKeep.messages.map((x) => [x.role, x.error ?? false, x.text.slice(0, 40)]),
    )}`,
  )
  assert.equal(empKeep.messages.filter((m) => m.role === 'agent').length, 2, '第一轮只说了一句 + 催促后的一轮')
  // 收尾：页面切走，让还挂着等下一句的 CLI 结束这一轮
  await call('POST', `/tasks/${empKeep.id}/presence`, { viewerId: 'e2e-empty', active: false })
  empKeep = await waitDone(empKeep.id, 20000)
  assert.equal(empKeep.status, 'done')

  // 一个字都没回的一轮（CLI 报成功、但没有正文也没有用量）：不能算完成。
  // 真实现场是带图请求被网关吞掉：那一轮被标成已完成并保活等下一句，用户之后发来的消息全落进死回合，既没回复也没报错
  step('一个字都没回的一轮不算完成：留下说明并自动接一轮')
  let sil = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'claude',
    prompt: 'FAKE_SILENT 分析一下这个对话',
  })
  sil = await waitDone(sil.id, 20000)
  assert.equal(sil.status, 'done', sil.messages.at(-1)?.text)
  const silNote = sil.messages.find((m) => m.role === 'system' && /没有返回任何内容/.test(m.text))
  assert.ok(
    silNote,
    `空成功的一轮必须留下可见说明，不能静默收尾；现有消息：${JSON.stringify(
      sil.messages.map((x) => [x.role, x.error ?? false, x.text.slice(0, 40)]),
    )}`,
  )
  assert.equal(sil.messages.filter((m) => m.role === 'agent' && m.text.trim()).length, 1, '自动接一轮之后正常给出回复')
  assert.match(sil.messages.find((m) => m.role === 'agent' && m.text.trim()).text, /这是 claude 的回复/)

  // 保活时第二句才空：同一个进程里前一轮有正文，空回合判定不能把它算进来，
  // 否则这条消息被标成已完成、进程接着保活，用户的话落进死回合（真实现场：17:54、17:55 两条消息都没回应）
  step('保活中的第二句一个字都没回：同样留下说明并重发这一句')
  {
    let sk = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: def.id,
      cli: 'commandcode',
      askUser: false,
      prompt: '先看代码',
    })
    await call('POST', `/tasks/${sk.id}/seen`, {})
    await call('POST', `/tasks/${sk.id}/presence`, { viewerId: 'e2e-silent-keep', active: true })
    for (let i = 0; i < 120 && !sk.awaitingUser; i++) {
      await sleep(100)
      sk = await call('GET', `/tasks/${sk.id}`)
    }
    assert.ok(sk.awaitingUser, '第一轮正常回复完停在等下一句上')
    await call('POST', `/tasks/${sk.id}/messages`, { text: 'FAKE_SILENT 第二句' })
    const retried = () =>
      sk.messages.some((m) => m.role === 'system' && /没有返回任何内容/.test(m.text)) &&
      sk.messages
        .slice(sk.messages.findIndex((m) => m.text === 'FAKE_SILENT 第二句') + 1)
        .some((m) => m.role === 'agent' && m.text.trim())
    for (let i = 0; i < 200 && !retried(); i++) {
      await sleep(150)
      sk = await call('GET', `/tasks/${sk.id}`)
    }
    assert.ok(
      retried(),
      `第二句空回合要留下说明并重发；现有消息：${JSON.stringify(
        sk.messages.map((x) => [x.role, x.error ?? false, x.text.slice(0, 40)]),
      )}`,
    )
    await call('POST', `/tasks/${sk.id}/presence`, { viewerId: 'e2e-silent-keep', active: false })
    sk = await waitDone(sk.id, 20000)
    assert.equal(sk.status, 'done', sk.messages.at(-1)?.text)
  }

  // Pi：按配置文件（shared/clis/pi.json）拼参数、走 --mode rpc（get_state / prompt / agent_settled）
  let pm = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'pi',
    prompt: '用 Pi',
  })
  pm = await waitDone(pm.id)
  assert.equal(pm.status, 'done', pm.messages.at(-1)?.text)
  c = calls().at(-1)
  assert.equal(c.kind, 'pi')
  assert.deepEqual(c.args.slice(0, 2), ['--mode', 'rpc'])
  assert.equal(
    c.args[c.args.indexOf('--tools') + 1],
    '+grep,+find,+ls,+codemode,+tool_search',
    '全部工具：在 Pi 默认工具上补搜索，codemode 默认开着并进同一个 --tools',
  )
  assert.ok(!c.args.includes('--exclude-tools'), '全部工具时不去掉任何工具')
  assert.equal(c.args[c.args.indexOf('--name') + 1], pm.title, '对话标题交给 Pi 当会话名')
  assert.match(c.input, /^## 用户这次的消息\n用 Pi\n\n/, '任务描述走 RPC 的 prompt 命令')
  const pReply = pm.messages.filter((m) => m.role === 'agent').at(-1)
  assert.match(pReply.text, /这是 pi 的回复/)
  assert.deepEqual(
    pReply.tools.map((x) => x.kind),
    ['read', 'edit'],
  )
  assert.equal(pm.usage.inputTokens, 4000, JSON.stringify(pm.usage))
  await call('POST', `/tasks/${pm.id}/messages`, { text: '继续' })
  await waitDone(pm.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--session') + 1], pm.sessions[pm.agentId], '继续时用 --session 续接会话')
  pm = await call('GET', `/tasks/${pm.id}`)
  assert.equal(pm.usage.agents[pm.agentId].context, 4321, '上下文占用以 get_session_stats 为准')
  // 压缩走 Pi 的 compact 命令，原地压缩会话；下一轮仍然续接同一个会话，不用写摘要开新会话
  const piSession = pm.sessions[pm.agentId]
  await call('POST', `/tasks/${pm.id}/compact`)
  pm = await waitDone(pm.id)
  c = calls().at(-1)
  assert.equal(c.op, 'compact', 'Pi 用 RPC 的 compact')
  assert.equal(c.args[c.args.indexOf('--session') + 1], piSession, '压缩的是当前会话')
  const piCompact = pm.messages.flatMap((m) => (m.role === 'agent' ? m.tools : [])).find((x) => x.kind === 'compact')
  assert.ok(piCompact, '压缩显示成回复里的一次工具调用（来自 compaction_end）')
  await call('POST', `/tasks/${pm.id}/messages`, { text: '压缩后继续' })
  pm = await waitDone(pm.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--session') + 1], piSession, '压缩后仍然续接原来的会话')
  assert.ok(!c.input.includes('之前对话的摘要'), '不用带摘要')
  // 撤回到某条消息：Pi 用 RPC 的 fork 截到那条消息之前，不用带上之前的对话开新会话
  pm = await call('GET', `/tasks/${pm.id}`)
  const piUsers = pm.messages.filter((m) => m.role === 'user' && !m.step)
  const piCut = piUsers.at(-1)
  assert.ok(piCut.turn?.id, `每一轮记下这一轮用户消息的 entryId：${JSON.stringify(piCut.turn)}`)
  assert.notEqual(piCut.turn.id, piUsers.at(-2).turn?.id, '每一轮的 entryId 不一样')
  await call('POST', `/tasks/${pm.id}/rewind`, { messageId: piCut.id })
  await call('POST', `/tasks/${pm.id}/messages`, { text: '换个做法' })
  pm = await waitDone(pm.id)
  assert.equal(pm.status, 'done', pm.messages.at(-1)?.text)
  c = calls().at(-1)
  assert.equal(c.forkAt, piCut.turn.id, '分叉到撤回的那条消息之前')
  assert.equal(c.args[c.args.indexOf('--session') + 1], piSession, '先打开原来的会话再分叉')
  assert.ok(!c.args.includes('--fork'))
  assert.ok(!c.input.includes('之前的对话'), '不用把之前的对话塞进提示词')
  assert.notEqual(pm.sessions[pm.agentId], piSession, '分叉出来的是新会话')
  // Pi 出错时退出码也是 0，按最后的 agent_settled 和 assistant 的 stopReason 判断失败
  let pf = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'pi',
    prompt: 'FAIL',
  })
  pf = await waitDone(pf.id)
  assert.equal(pf.status, 'failed')
  assert.match(JSON.stringify(pf.messages), /模拟的失败/)
  // 用户自己加的 CLI：数据目录 config/clis/ 下放一份配置，重新读取后就能用，不用改代码
  const gemSpec = JSON.parse(readFileSync(path.join(root, 'shared/clis/gemini.json'), 'utf8'))
  mkdirSync(path.join(dataDir, 'config/clis'), { recursive: true })
  writeFileSync(
    path.join(dataDir, 'config/clis/my-cli.json'),
    JSON.stringify({ ...gemSpec, id: 'my-cli', name: 'My CLI', command: fake, color: '#123456' }),
  )
  writeFileSync(path.join(dataDir, 'config/clis/broken.json'), JSON.stringify({ id: 'broken', name: 'x' }))
  const us = await call('POST', '/clis/specs/reload', {})
  assert.deepEqual(
    us.specs.map((x) => x.id),
    ['my-cli'],
  )
  assert.ok(
    us.errors.some((e) => /^broken\.json 已跳过：缺少字段 command/.test(e)),
    '写错的配置报出文件名和缺的字段：' + us.errors.join('\n'),
  )
  assert.ok((await call('GET', '/clis')).some((x) => x.id === 'my-cli' && x.installed))
  let mine = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'my-cli',
    prompt: '自己加的',
  })
  mine = await waitDone(mine.id)
  assert.equal(mine.status, 'done', mine.messages.at(-1)?.text)
  assert.match(calls().at(-1).input, /^## 用户这次的消息\n自己加的\n\n/)
  rmSync(path.join(dataDir, 'config/clis'), { recursive: true })
  assert.ok(!(await call('POST', '/clis/specs/reload', {})).specs.length, '删掉配置后不再有')
  step('Gemini CLI 按配置执行；数据目录里加一份配置就能接入新的 CLI')

  // 「/」命令：列出 CLI 自己的命令和 Skill；Claude Code 原样发，其他 CLI 展开成普通要求
  mkdirSync(path.join(project.path, '.claude/commands'), { recursive: true })
  writeFileSync(
    path.join(project.path, '.claude/commands/hello.md'),
    '---\ndescription: 打个招呼\nargument-hint: <名字>\n---\n跟 $ARGUMENTS 打个招呼',
  )
  mkdirSync(path.join(project.path, '.agents/skills/demo-skill'), { recursive: true })
  writeFileSync(
    path.join(project.path, '.agents/skills/demo-skill/SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示用的 Skill\n---\n按演示的步骤做事',
  )
  const cmds = await call('GET', `/clis/claude/commands?projectId=${project.id}`)
  const hello = cmds.find((x) => x.name === 'hello')
  assert.equal(hello?.kind, 'command')
  assert.equal(hello?.hint, '<名字>')
  assert.equal(hello?.description, '打个招呼')
  assert.ok(
    (await call('GET', `/clis/commandcode/commands?projectId=${project.id}`)).some((x) => x.name === 'demo-skill'),
  )
  let sc = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: def.id, prompt: '/hello 小明' })
  await waitDone(sc.id)
  assert.match(calls().at(-1).input, /^## 用户这次的消息\n\/hello 小明/, 'Claude Code 自己认得命令，原样发')
  sc = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'commandcode',
    prompt: '/demo-skill 做点事',
  })
  await waitDone(sc.id)
  c = calls().at(-1)
  assert.ok(c.input.includes('Skill「demo-skill」') && c.input.includes('按演示的步骤做事'), 'Skill 展开成要求')
  assert.ok(c.input.includes('做点事'))
  // 引入会话：整理成一份 Markdown 附件
  const ref = await call('POST', `/tasks/${sc.id}/transcript`, {})
  assert.ok(ref.name.endsWith('.md'))
  const refText = readFileSync(ref.path, 'utf8')
  assert.ok(refText.includes('# 参考会话') && refText.includes('/demo-skill 做点事'), refText)
  step('「/」命令和 Skill 按 CLI 列出、展开，会话能整理成附件引入')
  // 导入别人导出的任务：只读，密钥再去一遍，不能继续执行
  const at = new Date().toISOString()
  const bundle = {
    format: 'agent-panel/task',
    version: 1,
    exportedAt: at,
    app: '0.0.0',
    task: {
      title: '别人的任务',
      mode: 'chat',
      agentId: 'their-agent',
      status: 'done',
      messages: [
        { id: 'm1', role: 'user', text: '帮我看看', at },
        { id: 'm2', role: 'agent', agentId: 'their-agent', text: '用 sk-abcdefghijklmnopqrstuvwx 调接口', at },
      ],
      createdAt: at,
      updatedAt: at,
    },
    agents: [{ id: 'their-agent', name: '他们的 Agent', createdAt: at, updatedAt: at }],
  }
  const imp = await call('POST', '/tasks/import', { projectId: project.id, bundle })
  assert.equal(imp.projectId, project.id)
  assert.equal(imp.imported.agents[0].name, '他们的 Agent')
  assert.ok(!JSON.stringify(imp).includes('sk-abcdef'), '导入时去掉密钥')
  await assert.rejects(call('POST', `/tasks/${imp.id}/messages`, { text: '继续' }), /导入的任务/)
  await assert.rejects(call('POST', `/tasks/${imp.id}/fork`, { messageId: 'm1' }), /导入的任务/)
  await assert.rejects(call('PATCH', `/tasks/${imp.id}`, { askUser: true }), /导入的任务/)
  assert.equal((await call('PATCH', `/tasks/${imp.id}`, { title: '改个名' })).title, '改个名', '能改名')
  await assert.rejects(call('POST', '/tasks/import', { bundle: { format: 'x' } }), /不是 Agent 面板导出的任务/)
  await call('DELETE', `/tasks/${imp.id}`)
  step('导入别人导出的任务：只读，去掉密钥，不能继续执行')
  const other = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    model: 'x',
    prompt: '别的',
  })
  assert.equal(other.model, '', '其他 Agent 不接受临时模型')
  await waitDone(other.id)
  // Chat 模式：不属于项目的聊天，在数据目录里单独的工作目录执行
  // 旧客户端还会传以前默认 Agent 的 id：按不用角色处理
  let free = await call('POST', '/tasks', { mode: 'chat', agentId: 'default-agent', prompt: '随便聊聊' })
  assert.equal(free.projectId, '')
  assert.equal(free.agentId, '', '旧的默认 Agent id 当成不用角色')
  free = await waitDone(free.id)
  assert.equal(free.status, 'done')
  c = calls().at(-1)
  assert.equal(c.cwd, path.join(dataDir, 'chats', free.id), '聊天不在任何项目目录里执行')
  await call('POST', `/tasks/${free.id}/messages`, { text: '再说说' })
  free = await waitDone(free.id)
  assert.ok(calls().at(-1).args.includes('--resume'), '聊天继续时续接会话')
  assert.equal(
    (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'workflow', prompt: 'x' }),
      })
    ).status,
    400,
    '工作流必须选项目',
  )
  await fetch(`${base}/tasks/${free.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
  assert.ok(!existsSync(path.join(dataDir, 'chats', free.id)), '删除聊天时工作目录一起删掉')
  step(
    '不用角色：直接用默认 CLI，对话时可以临时换模型和思考强度，旧的默认 Agent id 当成不用角色；任务记录执行时间；Chat 模式的聊天不属于项目',
  )

  // ---- 停止 ----
  let slow = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'SLOW 慢慢来' })
  await sleep(800)
  const t0 = Date.now()
  await call('POST', `/tasks/${slow.id}/stop`)
  slow = await waitDone(slow.id, 8000)
  assert.equal(slow.status, 'stopped')
  assert.ok(Date.now() - t0 < 5000, '停止应该很快生效')
  step('停止：进程被结束，任务标记为已停止')

  // ---- 强制停止：任务停下，CLI 进程一起结束（不留给下一句、后台命令也不留在后面）----
  const forcedTask = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    prompt: 'SLOW 强制停止',
  })
  await sleep(800)
  const forcedPid = calls().at(-1)?.pid
  await call('POST', `/tasks/${forcedTask.id}/stop?force=1`)
  const forcedDone = await waitDone(forcedTask.id, 8000)
  assert.equal(forcedDone.status, 'stopped')
  let forcedEnd = null
  for (let i = 0; i < 40 && !forcedEnd; i++) {
    forcedEnd = calls().find((c) => c.pid === forcedPid)?.end
    if (!forcedEnd) await sleep(150)
  }
  assert.ok(forcedPid && forcedEnd, '强制停止后 CLI 进程结束了')
  step('强制停止：任务停下，CLI 进程一起结束')

  // ---- 插话：Codex 用 turn/steer、Claude Code 写进 stdin、Command Code 用常驻 RPC 的 turn/steer，交给正在跑的这一轮 ----
  {
    const steerLog = () => readLog(`${log}.steer`)
    const chatWith = (extra, prompt) =>
      call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: '', prompt, ...extra })
    let a = await chatWith({ cli: 'codex' }, 'SLOW 插话 codex')
    let b = await chatWith({ cli: 'claude' }, 'SLOW 插话 claude')
    let q = await chatWith({ cli: 'commandcode' }, 'SLOW 插话 cmd')
    await sleep(1200)
    a = await call('POST', `/tasks/${a.id}/messages`, { text: '顺便看看测试' })
    b = await call('POST', `/tasks/${b.id}/messages`, { text: '也看看文档' })
    q = await call('POST', `/tasks/${q.id}/messages`, { text: '插话给命令行' })
    assert.ok(
      a.messages.some((m) => m.role === 'user' && m.text === '顺便看看测试'),
      '插话的内容马上出现在对话里',
    )
    assert.ok(
      q.messages.some((m) => m.role === 'user' && m.text === '插话给命令行'),
      'Command Code 的插话也立刻进对话',
    )
    a = await waitDone(a.id)
    b = await waitDone(b.id)
    q = await waitDone(q.id)
    assert.equal(a.status, 'done')
    assert.equal(b.status, 'done')
    const sl = steerLog()
    assert.ok(
      sl.some((x) => x.kind === 'codex' && x.steered.some((s) => s.includes('顺便看看测试'))),
      'Codex 收到了插话',
    )
    assert.ok(
      sl.some((x) => x.kind === 'claude' && x.steered.some((s) => s.includes('也看看文档'))),
      'Claude Code 收到了插话',
    )
    assert.ok(
      sl.some((x) => x.kind === 'commandcode' && x.steered.some((s) => s.includes('插话给命令行'))),
      'Command Code 收到了插话',
    )
    const at = a.messages.findIndex((m) => m.text === '顺便看看测试')
    assert.ok(
      a.messages.slice(at + 1).some((m) => m.role === 'agent' && m.text.includes('codex 的回复')),
      '插话之后的输出排在插话后面',
    )
    // 命令的输出边跑边显示，完成后不再是执行中
    const run = a.messages.flatMap((m) => m.tools).find((x) => x.kind === 'run')
    assert.equal(run.output, 'total 8\nREADME.md\n')
    assert.ok(!run.running)
    assert.equal(typeof run.ms, 'number', '跑完的命令记下了耗时')
    step('插话：Codex、Claude Code、Command Code 都交给正在跑的这一轮；命令输出边跑边显示')

    // Pi 的插话要等这一批工具跑完才取：模型在前台 sleep 等 CI 时，面板停下命令，把插话作为新的一句交给它
    let pz = await chatWith({ cli: 'pi' }, 'FAKE_PI_SLEEP 等 CI')
    for (let i = 0; i < 40; i++) {
      pz = await call('GET', `/tasks/${pz.id}`)
      if (pz.messages.some((m) => m.tools.some((x) => x.kind === 'run'))) break
      await sleep(150)
    }
    await call('POST', `/tasks/${pz.id}/messages`, { text: '推送远端' })
    pz = await waitDone(pz.id)
    assert.equal(pz.status, 'done', '停下命令不算这一轮失败')
    const redirected = readLog(`${log}.redirect`)
    assert.ok(
      redirected.some((x) => x.text.includes('推送远端') && x.text.includes('面板说明')),
      'Pi 收到的新一句是插话加上命令被停下的说明',
    )
    const said = pz.messages.findIndex((m) => m.role === 'user' && m.text === '推送远端')
    const after = pz.messages.slice(said + 1)
    assert.ok(
      pz.messages.some((m) => m.tools.some((x) => x.label === '为了马上处理新消息，停下了正在执行的命令')),
      '回复里标出停下了命令',
    )
    assert.ok(
      after.some((m) => m.role === 'agent' && m.text.includes('好的，马上推送')),
      '回复排在插话后面',
    )
    step('插话被长命令挡着（Pi）：停下命令，插话马上交给 Pi，这一轮照常完成')

    // ---- 额度：Codex 主动查，Claude Code 用执行时收到的 ----
    const cl = await call('GET', '/clis/codex/limits')
    assert.deepEqual(
      cl.windows.map((w) => [w.id, w.usedPercent]),
      [
        ['five_hour', 42],
        ['seven_day', 7],
      ],
    )
    assert.equal(cl.plan, 'plus')
    const al = await call('GET', '/clis/claude/limits')
    assert.deepEqual(
      al.windows.map((w) => [w.id, w.usedPercent]),
      [
        ['five_hour', 25],
        ['seven_day', 50],
      ],
    )
    const sk = await call('GET', `/clis/codex/skills?projectId=${project.id}`)
    assert.deepEqual(
      sk.map((x) => x.name),
      ['fake-skill'],
    )
    assert.ok(Array.isArray(await call('GET', '/clis/claude/skills')))
    step('额度：Codex 读 account/rateLimits，Claude Code 用 rate_limit_event；Skill 列表')

    // ---- 压缩上下文 ----
    await call('POST', `/tasks/${a.id}/compact`)
    a = await waitDone(a.id)
    assert.equal(calls().at(-1).op, 'compact', 'Codex 用 thread/compact/start')
    const compactTool = (x) =>
      x.messages.flatMap((m) => (m.role === 'agent' ? m.tools : [])).find((t) => t.kind === 'compact')
    assert.ok(compactTool(a), '压缩显示成回复里的一次工具调用')
    assert.ok(!a.messages.some((m) => m.role === 'system' && m.text === '已压缩上下文'), '不插系统消息把回复切开')
    await call('POST', `/tasks/${b.id}/compact`)
    b = await waitDone(b.id)
    assert.equal(calls().at(-1).input, '/compact', 'Claude Code 用 /compact')
    assert.match(compactTool(b).label, /9\.0k/, '写明压缩前的大小（compact_boundary 的 pre_tokens）')
    let cc = await chatWith({ cli: 'commandcode' }, '第一件事')
    cc = await waitDone(cc.id)
    await call('POST', `/tasks/${cc.id}/compact`)
    cc = await waitDone(cc.id)
    assert.ok(calls().at(-1).input.includes('整理成一份摘要'), 'Command Code 写摘要')
    await call('POST', `/tasks/${cc.id}/messages`, { text: '接着做' })
    cc = await waitDone(cc.id)
    let c = calls().at(-1)
    assert.ok(!c.args.includes('--resume'), '压缩后开新会话')
    assert.ok(c.input.includes('之前对话的摘要') && c.input.includes('接着做'), '新会话带上摘要')
    step('压缩上下文：Codex 用 thread/compact/start，Claude Code 用 /compact，Command Code 写摘要后开新会话')

    // ---- 审查改动 ----
    await call('POST', `/tasks/${a.id}/review`)
    a = await waitDone(a.id)
    c = calls().at(-1)
    assert.equal(c.op, 'review')
    assert.deepEqual(c.reviewTarget, { type: 'uncommittedChanges' })
    assert.equal(a.messages.at(-1).text, '审查结论：没有发现问题。', '只显示审查结论')
    await call('POST', `/tasks/${b.id}/review`, { base: 'main' })
    b = await waitDone(b.id)
    assert.ok(calls().at(-1).input.includes('请审查当前分支相对 main 的改动'))
    step('审查改动：Codex 用审查模式，其他 CLI 按审查的要求跑一轮')

    // ---- 分叉、撤回 ----
    let f = await chatWith({ cli: 'claude' }, '第一问')
    f = await waitDone(f.id)
    await call('POST', `/tasks/${f.id}/messages`, { text: '第二问' })
    f = await waitDone(f.id)
    const [u1, u2] = f.messages.filter((m) => m.role === 'user')
    assert.ok(u1.turn?.end && u2.turn?.end, 'Claude Code 的每一轮记下最后一条回复的 uuid')
    let fk = await call('POST', `/tasks/${f.id}/fork`, { messageId: u1.id })
    assert.deepEqual(
      fk.messages.filter((m) => m.role === 'user').map((m) => m.text),
      ['第一问'],
      '分叉只带到这条消息和它的回复',
    )
    await call('POST', `/tasks/${fk.id}/messages`, { text: '分叉后' })
    fk = await waitDone(fk.id)
    c = calls().at(-1)
    const argAt = (k) => c.args[c.args.indexOf(k) + 1]
    assert.equal(argAt('--resume'), u1.turn.session)
    assert.ok(c.args.includes('--fork-session'))
    assert.equal(argAt('--resume-session-at'), u1.turn.end, '从第一轮的最后一条回复截断')
    assert.ok(!fk.rewind, '分叉后接上了新会话')
    const rw = await call('POST', `/tasks/${f.id}/rewind`, { messageId: u2.id })
    assert.equal(rw.text, '第二问', '撤回的内容交回去方便改')
    assert.deepEqual(
      rw.task.messages.filter((m) => m.role === 'user').map((m) => m.text),
      ['第一问'],
    )
    await call('POST', `/tasks/${f.id}/messages`, { text: '改过的第二问' })
    await waitDone(f.id)
    c = calls().at(-1)
    assert.equal(argAt('--resume-session-at'), u1.turn.end)
    // Codex：thread/fork 带上那一轮的 turn id
    let g = await chatWith({ cli: 'codex' }, '问 codex')
    g = await waitDone(g.id)
    const gu = g.messages.find((m) => m.role === 'user')
    assert.equal(gu.turn.id, 't1')
    const gk = await call('POST', `/tasks/${g.id}/fork`, { messageId: gu.id })
    await call('POST', `/tasks/${gk.id}/messages`, { text: '分叉后' })
    await waitDone(gk.id)
    assert.deepEqual(calls().at(-1).fork, { from: gu.turn.session, lastTurnId: 't1' })
    // Command Code：截在中间时开新会话，把留下的对话带上
    let h = await chatWith({ cli: 'commandcode' }, '甲问题')
    h = await waitDone(h.id)
    await call('POST', `/tasks/${h.id}/messages`, { text: '乙问题' })
    h = await waitDone(h.id)
    const hu = h.messages.filter((m) => m.role === 'user')
    await call('POST', `/tasks/${h.id}/rewind`, { messageId: hu[1].id })
    await call('POST', `/tasks/${h.id}/messages`, { text: '丙问题' })
    await waitDone(h.id)
    c = calls().at(-1)
    assert.ok(!c.args.includes('--resume'))
    assert.ok(c.input.includes('之前的对话') && c.input.includes('甲问题') && !c.input.includes('乙问题'))
    // 从最后一轮分叉可以直接用 --fork-session
    const hk = await call('POST', `/tasks/${h.id}/fork`, {
      messageId: (await call('GET', `/tasks/${h.id}`)).messages.filter((m) => m.role === 'user').at(-1).id,
    })
    await call('POST', `/tasks/${hk.id}/messages`, { text: '丁问题' })
    await waitDone(hk.id)
    c = calls().at(-1)
    assert.ok(c.args.includes('--resume') && c.args.includes('--fork-session'))
    step(
      '对话分叉、撤回：Claude Code 用 --resume-session-at，Codex 用 thread/fork，Command Code 截不了时带上之前的对话',
    )

    // ---- 自动压缩阈值：Claude Code 用环境变量，Codex 换算成 token 数 ----
    await call('PUT', '/settings', {
      ...settings,
      clis: {
        ...settings.clis,
        claude: cli({ defaultModel: 'sonnet', autoCompact: 70 }),
        codex: cli({ autoCompact: 50 }),
      },
    })
    let z1 = await chatWith({ cli: 'claude' }, '自动压缩')
    await waitDone(z1.id)
    assert.equal(calls().at(-1).compactPct, '70')
    let z2 = await chatWith({ cli: 'codex' }, '自动压缩')
    await waitDone(z2.id)
    assert.ok(
      calls()
        .at(-1)
        .args.some((x) => /^model_auto_compact_token_limit=\d+$/.test(x)),
    )
    await call('PUT', '/settings', settings)
    step('自动压缩阈值：Claude Code 用 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE，Codex 用 model_auto_compact_token_limit')
  }

  // ---- 执行中发消息：立刻进对话，能交给 CLI 就实时送达；交不出去时这一轮结束后马上接着处理 ----
  {
    // Claude Code 能在执行中插话：发出去立刻是正常消息，并被交给正在跑的这一轮
    let q = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      cli: 'claude',
      prompt: 'SLOW 执行中发消息',
    })
    await sleep(500)
    const before = q.messages.length
    q = await call('POST', `/tasks/${q.id}/messages`, { text: '执行中补一句' })
    assert.equal('queue' in q, false, '不再有排队字段')
    assert.equal(q.messages.length, before + 1, '消息马上进对话')
    assert.equal(q.messages.at(-1).text, '执行中补一句')
    assert.equal(q.status, 'running', '这一轮还在跑')
    // Command Code 用常驻 RPC 的 turn/steer，同样立刻进对话
    let c = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      prompt: 'SLOW 执行中发给命令行',
    })
    await sleep(800)
    c = await call('POST', `/tasks/${c.id}/messages`, { text: '命令行也来一句' })
    assert.ok(
      c.messages.some((m) => m.role === 'user' && m.text === '命令行也来一句'),
      'Command Code 的消息也立刻进对话',
    )
    q = await waitDone(q.id)
    c = await waitDone(c.id)
    assert.equal(q.status, 'done')
    assert.equal(c.status, 'done')
    assert.ok(
      readLog(`${log}.steer`).some((x) => x.steered.some((s) => s.includes('执行中补一句'))),
      'Claude Code 收到了执行中发的消息',
    )
    // 既不能插话、也不用面板工具取补充的 CLI（Gemini CLI）：消息照样立刻进对话，
    // 这一轮完全结束后马上开始新一轮接着处理，不用用户再发一次
    let g = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'gemini',
      prompt: 'SLOW 交不出去的消息',
    })
    const g0 = calls().filter((c) => c.kind === 'gemini').length
    await sleep(800)
    g = await call('POST', `/tasks/${g.id}/messages`, { text: '这一轮结束后处理这条' })
    assert.equal(g.messages.at(-1).text, '这一轮结束后处理这条', '交不出去的消息也立刻进对话')
    assert.equal(g.status, 'running', '第一轮还没结束')
    // 第一轮结束后自动开新一轮：等两轮都跑完（中间会短暂停在 done）
    const t1 = Date.now()
    for (;;) {
      g = await call('GET', `/tasks/${g.id}`)
      const users = g.messages.filter((m) => m.role === 'user').length
      const finished =
        g.status !== 'running' && users >= 2 && calls().filter((c) => c.kind === 'gemini').length >= g0 + 2
      if (finished) break
      if (Date.now() - t1 > 30000) throw new Error('执行中收到的消息没有在下一轮接着处理')
      await sleep(100)
    }
    assert.equal(g.status, 'done')
    const texts = g.messages.filter((m) => m.role === 'user').map((m) => m.text)
    assert.deepEqual(texts, ['SLOW 交不出去的消息', '这一轮结束后处理这条'], '这一轮结束后自动接着处理，不重复记消息')
    // 打断：停下当前这一轮马上处理
    let r = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      prompt: 'SLOW 打断测试',
    })
    await sleep(500)
    const t0 = Date.now()
    r = await call('POST', `/tasks/${r.id}/messages`, { text: '马上改做这个', interrupt: true })
    r = await waitDone(r.id, 10000)
    assert.ok(Date.now() - t0 < 8000, '打断后很快处理新的要求')
    assert.equal(r.status, 'done')
    assert.equal(r.messages.filter((m) => m.role === 'user').at(-1).text, '马上改做这个')
  }
  step('执行中发消息：立刻进对话并实时交给 CLI，不再有排队；也可以打断马上处理')

  // ---- 子对话的 CLI 生命周期：列表如实给 cliAlive；打开父对话不启动任何子对话；发消息才启动 ----
  {
    let parent = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '父对话' })
    parent = await waitDone(parent.id, 20000)
    assert.equal(parent.status, 'done')
    // 子对话直接用接口建（对话 Agent 建子对话需要走工作流，这里只测进程生命周期）
    const mkChild = (title, prompt) =>
      call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, parentTaskId: parent.id, prompt })
    let kid = await mkChild('子对话一', '第一件事')
    kid = await waitDone(kid.id, 20000)
    assert.equal(kid.status, 'done')

    // 状态先标成完成、进程随后才退出：等一小会儿再看，免得偶尔撞上进程还没退干净
    let kids = await call('GET', `/tasks/${parent.id}/children`)
    for (let i = 0; i < 20 && kids.find((x) => x.id === kid.id)?.cliAlive; i++) {
      await sleep(100)
      kids = await call('GET', `/tasks/${parent.id}/children`)
    }
    const one = kids.find((x) => x.id === kid.id)
    assert.ok(one, '子对话出现在父对话的列表里')
    assert.equal(one.cliAlive, false, '跑完、进程已经结束：cliAlive 为 false')
    assert.ok(one.lastMessageAt, '列表带上最近一条消息的时间，用来排序')
    assert.ok(!('queue' in kid), '不再有排队字段')

    // 只打开父对话页、只读查子对话：不会把子对话的 CLI 启动起来
    await call('POST', `/tasks/${parent.id}/presence`, { viewerId: 'e2e', active: true })
    await call('GET', `/tasks/${parent.id}/children`)
    kids = await call('GET', `/tasks/${parent.id}/children`)
    assert.equal(kids.find((x) => x.id === kid.id).cliAlive, false, '打开父对话不会启动子对话的 CLI')
    assert.ok(!(await call('GET', `/tasks/${kid.id}`)).prewarming, '也不会预热')

    // 打开子对话页，不发消息：仍然没有启动
    await call('POST', `/tasks/${kid.id}/presence`, { viewerId: 'e2e-child', active: true })
    kids = await call('GET', `/tasks/${parent.id}/children`)
    assert.equal(kids.find((x) => x.id === kid.id).cliAlive, false, '只打开子对话也不启动 CLI')

    // 真正发消息才启动
    const resumed = await call('POST', `/tasks/${kid.id}/messages`, { text: '接着做第二件事' })
    assert.equal(resumed.status, 'running', '发消息才启动这一轮')
    kids = await call('GET', `/tasks/${parent.id}/children`)
    assert.equal(kids.find((x) => x.id === kid.id).cliAlive, true, '发消息后进程活着')
    const busy = await call('GET', '/tasks')
    assert.ok(
      busy.find((x) => x.id === parent.id)?.childrenWorking >= 1,
      '子对话在跑时父对话的摘要带上 childrenWorking，侧栏据此显示执行中',
    )
    kid = await waitDone(kid.id, 20000)
    assert.equal(kid.status, 'done')
    step('子对话：列表如实给 cliAlive，打开对话不启动 CLI，发消息才启动，父对话带上 childrenWorking')

    // 父对话的 CLI 结束时一起结束子对话的进程
    let slow = await mkChild('子对话二', 'SLOW 父对话关闭时一起结束')
    await sleep(600)
    assert.equal((await call('GET', `/tasks/${slow.id}`)).status, 'running', '子对话正在执行')
    await call('POST', `/tasks/${parent.id}/stop`)
    slow = await waitDone(slow.id, 15000)
    assert.notEqual(slow.status, 'running', '父对话的 CLI 结束后，子对话的进程也结束了')
    assert.ok(slow.messages.length > 0, '停止时保留已有的输出，下次发消息能重新启动')
    // 停止时子对话的进程是异步结束的（stopTask 里的 closeChildren 不阻塞停止请求），
    // 状态先落盘、进程随后退出，这里等一小会儿再看，不和进程回收抢时间
    let after = await call('GET', `/tasks/${parent.id}/children`)
    for (let i = 0; i < 30 && after.find((x) => x.id === slow.id)?.cliAlive; i++) {
      await sleep(100)
      after = await call('GET', `/tasks/${parent.id}/children`)
    }
    assert.equal(after.find((x) => x.id === slow.id).cliAlive, false, '子对话的进程没有留成孤儿')
    // 父对话自己也停掉，后面的用例从干净状态开始
    await waitDone(parent.id, 15000)
    step('父对话关闭：名下子对话的 CLI 一起结束，已有内容保留')

    // ---- 子对话不建独立分支：和父对话共用一个目录；父对话在独立分支里时就在父的那个目录 ----
    const isoNew = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: A.id,
      prompt: 'COMMIT BEGIN_EDIT 父对话在独立分支',
      isolate: true,
    })
    assert.equal(isoNew.worktree, null, '对话要改文件时才开独立分支，创建时还没开')
    assert.equal(isoNew.wantsWorktree, true)
    const isoParent = await waitTask(isoNew.id, (t) => t.worktree?.state === 'active' && !t.wantsWorktree)
    assert.equal(isoParent.worktree?.state, 'active', '顶层对话传了 isolate 才隔离')
    let isoKid = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: isoParent.id,
      prompt: 'COMMIT 子对话在父分支上改',
      isolate: true,
    })
    assert.equal(isoKid.worktree, null, '子对话传了 isolate 也不建独立分支')
    isoKid = await waitDone(isoKid.id, 20000)
    assert.ok(
      gitIn(isoParent.worktree.path, 'log', '--oneline').toString().includes('子对话'),
      '子对话直接在父对话的分支目录里提交',
    )
    const parentDropped = await call('POST', `/tasks/${isoParent.id}/worktree/discard`)
    assert.equal(parentDropped.worktree.state, 'discarded')
    await call('DELETE', `/tasks/${isoParent.id}`)
    step('子对话不建独立分支：和父对话共用目录，父对话在独立分支里时就在父的目录里改')

    // ---- 项目设成「独立 worktree」：子对话各自开分支改，编译交给面板合回原目录 ----
    const { id: _pid, createdAt: _c, updatedAt: _u, ...projectInput } = project
    await call('PUT', `/projects/${project.id}`, { ...projectInput, childIsolation: 'worktree' })
    const wtParent = await waitDone(
      (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: '父对话' })).id,
      20000,
    )
    assert.equal(wtParent.worktree, null, '父对话没开独立分支')
    let wtKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: wtParent.id,
          prompt: 'COMMIT BEGIN_EDIT 子对话在自己的分支里改',
        })
      ).id,
      20000,
    )
    // 第一轮在原目录里查看，调用 begin_edit 后才开分支，面板马上在分支目录里开新会话接着做
    const editLog = readLog(log + '.edit')
    assert.ok(editLog.length && !editLog.at(-1).got.isError, '子对话调用 begin_edit 开了分支')
    assert.equal(editLog.at(-1).cwd, project.path, '开分支前在原目录里')
    wtKid = await waitTask(wtKid.id, () => calls().at(-1)?.cwd !== project.path)
    assert.equal(wtKid.worktree?.state, 'active', '子对话要改文件时开了独立分支')
    assert.ok(
      !wtKid.messages.some((m) => m.role === 'system' && m.text.includes('已开独立分支')),
      '开分支不另记居中提示，begin_edit 这次调用本身就是对话里的一行',
    )
    assert.equal(calls().at(-1).cwd, wtKid.worktree.path, '开分支后的一轮在分支目录里执行')
    assert.match(calls().at(-1).input, /之前的对话[\s\S]*BEGIN_EDIT/, '新会话带上了之前的对话')
    assert.ok(!calls().at(-1).args.includes('--resume'), '换了目录不续接旧会话')
    assert.ok(
      !gitIn(project.path, 'log', '--oneline').toString().includes('子对话在自己的分支'),
      '提交在子对话的分支上，项目目录不受影响',
    )
    const wtList = await call('GET', `/tasks/${wtParent.id}/children`)
    assert.equal(wtList.find((x) => x.id === wtKid.id)?.branch, wtKid.worktree.branch, '子对话列表带上分支')
    const wtPrompt = JSON.stringify(calls().at(-1))
    assert.match(wtPrompt, /别的子对话改不到这里/, '提示里说明了在独立分支里改')
    assert.match(wtPrompt, /在独立分支里验证，再合回原分支/, '提示里说明在自己的分支里编译测试、再合回去')
    assert.match(wtPrompt, /submit_merge/, '合回原分支用 submit_merge')
    assert.ok(!wtPrompt.includes('claim_files 认领'), '独立分支里不用认领文件')
    // 假 CLI 每次都在工作目录写输出文件：项目目录里前面测试留下的那份没进版本控制，会挡住合并
    for (const f of ['codex-output.txt', 'claude-output.txt']) rmSync(path.join(project.path, f), { force: true })
    const before = (await call('GET', `/tasks/${wtParent.id}/worktrees`)).items
    assert.equal(before.length, 1, '父对话的独立分支列表带上子对话的')
    assert.ok(before[0].child && !before[0].merged && before[0].ahead + before[0].dirty > 0, '子对话的分支还没合并')
    // 还没合回原分支时不能标记完成：标记完成会删掉分支
    const early = await fetch(`${base}/tasks/${wtKid.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    })
    assert.equal(early.status, 409, '有没合并的改动时不标记完成')
    assert.match((await early.json()).error, /先合并或删除分支/)
    const merged = await call('POST', `/tasks/${wtKid.id}/worktree/merge`)
    assert.equal(merged.task.worktree.state, 'active', '合并后分支留着，对话还能接着改')
    assert.ok(
      gitIn(project.path, 'log', '--oneline').toString().includes('子对话在自己的分支'),
      '合并后提交回到项目目录',
    )
    assert.ok((await call('GET', `/tasks/${wtParent.id}/worktrees`)).items[0].merged, '合并后标成已合并')
    // 合完再标记完成：独立分支的目录和分支一起删掉
    const wtDir = merged.task.worktree.path
    const resolved = await call('PATCH', `/tasks/${wtKid.id}`, { resolved: true })
    assert.equal(resolved.resolved, true)
    assert.equal(resolved.worktree.state, 'merged', '标记完成后独立分支记成已合并')
    assert.ok(!existsSync(wtDir), '标记完成后独立分支的目录删掉了')
    assert.ok(
      !gitIn(project.path, 'branch', '--list', merged.task.worktree.branch).toString().trim(),
      '标记完成后分支也删掉了',
    )
    step('子对话标记完成：没合并时拦下，合并后删掉独立分支')
    // 子对话请父对话决定：父对话里是一张提问卡片（带选项），用户在卡片上回答后直接交给子对话
    const askKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: wtParent.id,
          prompt: 'ASK_PARENT 选一个方案',
        })
      ).id,
      20000,
    )
    let askParent = await call('GET', `/tasks/${wtParent.id}`)
    const askMsg = askParent.messages.find((m) => m.panel === 'ask')
    assert.ok(askMsg, '父对话里记了提问卡片')
    assert.equal(askMsg.ask.from, askKid.id)
    assert.deepEqual(askMsg.ask.options, ['A 方案', 'B 方案'], '卡片带上子对话给的选项')
    assert.equal(askMsg.ask.answer, undefined, '还没回答')
    assert.deepEqual(
      (await call('GET', `/tasks/${askKid.id}`)).parentAsks?.map((x) => x.id),
      [askMsg.id],
      '子对话上也挂着这个提问，输入框换成选择弹窗',
    )
    assert.ok(
      !askParent.messages.some((m) => m.role === 'system' && !m.panel && m.text.includes('提问')),
      '提问不再是居中的系统提示',
    )
    await call('POST', `/tasks/${wtParent.id}/child-asks/${askMsg.id}`, { answer: 'B 方案', delegate: false })
    await waitTask(askKid.id, (k) => k.messages.some((m) => m.role === 'user' && m.text.includes('用户的决定')))
    askParent = await call('GET', `/tasks/${wtParent.id}`)
    const answeredAsk = askParent.messages.find((m) => m.id === askMsg.id)
    assert.equal(answeredAsk.ask.answer, 'B 方案')
    assert.equal(answeredAsk.ask.by, 'user')
    await waitTask(askKid.id, (k) => !k.parentAsks?.length)
    assert.ok(
      askParent.inbox.some((x) => x.from === askKid.id && x.text.includes('用户已回答')) &&
        !askParent.inbox.some((x) => x.from === askKid.id && x.text.startsWith('（提问）')),
      '父对话的收件箱里换成「用户已回答」，不会再答一遍',
    )
    await call('DELETE', `/tasks/${wtParent.id}`)
    await call('PUT', `/projects/${project.id}`, projectInput)
    step('子对话独立 worktree：第一次执行时开分支，提交不影响项目目录，编译交给面板，合并后回到原目录')

    // ---- 执行计划：步骤挂在后台命令上等结果，结果回来自动标完成；计划做完没写总结时面板追一轮要总结 ----
    {
      const planned = await waitDone(
        (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'PLAN_BG 列计划' }))
          .id,
        20000,
      )
      assert.equal(planned.plans.length, 1, '列了一份计划')
      const done = await waitTask(planned.id, (k) => !!k.plans[0]?.summary, 30000)
      const plan = done.plans[0]
      assert.deepEqual(
        plan.steps.map((x) => [x.title, x.status]),
        [
          ['改代码', 'done'],
          ['跑测试', 'done'],
        ],
        '后台命令成功后，等它的步骤自动标完成',
      )
      assert.equal(plan.steps[1].waits[0].state, 'ok')
      assert.ok(plan.doneAt, '全部完成后计划收起')
      assert.equal(plan.summary, '改好了代码，测试通过', '面板追要总结，AI 调用 finish_plan 写下')
      assert.ok(
        done.messages.some((m) => m.panel === 'background' && m.text.includes('计划步骤「跑测试」')),
        '推回的后台结果点名是计划里哪一步在等',
      )
      await call('DELETE', `/tasks/${planned.id}`)
      step('执行计划：等待中的步骤结果回来自动完成，计划做完必须写总结')
    }

    // ---- 全局规则：父对话输入 /rule 发布，不发给 CLI；子对话这一轮的提示里带上 ----
    const ruleParent = await waitDone(
      (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '父对话' })).id,
      20000,
    )
    const ruled = await call('POST', `/tasks/${ruleParent.id}/messages`, { text: '/rule 不要改 package.json' })
    assert.deepEqual(
      ruled.rules.map((r) => r.text),
      ['不要改 package.json'],
      '规则存在父对话上',
    )
    assert.match(ruled.messages.at(-1).text, /已发布全局规则/)
    assert.notEqual(ruled.status, 'running', '/rule 由面板处理，不启动 CLI')
    const ruleKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: ruleParent.id,
          prompt: '子对话看规则',
        })
      ).id,
      20000,
    )
    assert.equal(ruleKid.worktree, null)
    const kidLog = JSON.stringify(calls().at(-1))
    assert.ok(
      kidLog.includes('全局规则（父对话发布，必须遵守）') && kidLog.includes('不要改 package.json'),
      '子对话的提示里带上了父对话的全局规则',
    )
    // 子对话完成后才回报父对话：等回报进来，免得它插在下面 /rule 的回复后面
    for (let i = 0; i < 30; i++) {
      const p = await call('GET', `/tasks/${ruleParent.id}`)
      if (p.messages.some((m) => m.text.includes('子对话「子对话看规则」'))) break
      await sleep(100)
    }
    const listed = await call('POST', `/tasks/${ruleParent.id}/messages`, { text: '/rule' })
    assert.match(listed.messages.at(-1).text, /1\. 不要改 package\.json/)
    const cleared = await call('POST', `/tasks/${ruleParent.id}/messages`, { text: '/rule clear' })
    assert.deepEqual(cleared.rules, [])
    const childRule = await call('POST', `/tasks/${ruleKid.id}/messages`, { text: '/rule 子对话不能发' }).catch(
      (e) => e,
    )
    assert.match(String(childRule.message ?? childRule), /只能在项目对话里发布/)
    // 对话设置：目标和规则交给子对话，子对话按指定的 CLI 跑，并发上限和停止全部子对话
    const conf = await call('PATCH', `/tasks/${ruleParent.id}`, {
      goal: '商品页支持到货通知',
      rules: [{ id: 'r1', text: '只改 src 下的文件', at: new Date().toISOString() }],
      childRun: { cli: 'codex', model: '', effort: '' },
      childLimit: 2,
    })
    assert.equal(conf.goal, '商品页支持到货通知')
    assert.equal(conf.childLimit, 2)
    assert.equal(conf.childRun.cli, 'codex')
    await waitDone((await call('POST', `/tasks/${ruleKid.id}/messages`, { text: '按设置再做一次' })).id, 20000)
    const confLog = calls().at(-1)
    assert.equal(confLog.kind, 'codex', '子对话按父对话设置里的 CLI 执行')
    const confText = JSON.stringify(confLog)
    assert.ok(confText.includes('父对话的目标') && confText.includes('商品页支持到货通知'), '子对话看得到父对话的目标')
    assert.ok(confText.includes('只改 src 下的文件'), '设置里改的规则交给子对话')
    const back = await call('PATCH', `/tasks/${ruleParent.id}`, { childRun: null })
    assert.equal(back.childRun, undefined, '改回按角色自己的配置')
    assert.equal(typeof (await call('POST', `/tasks/${ruleParent.id}/children/stop`)).stopped, 'number')
    await call('DELETE', `/tasks/${ruleParent.id}`)
    step(
      '全局规则：/rule 发布、列出、清空，子对话的提示里带上，子对话自己不能发；对话设置的目标、规则、子对话 CLI 生效',
    )

    // ---- 项目教训：单独的接口记一条（同名更新），新会话的提示里带全局条目全文和按文件条目的标题 ----
    await call('POST', `/projects/${project.id}/lessons`, {
      title: '价格一律用整数分',
      rule: '格式化统一走 formatPrice',
    })
    await call('POST', `/projects/${project.id}/lessons`, {
      title: '支付方式写进配置',
      rule: '下单流程只读配置字段，不按名字判断',
      paths: ['src/payment/**'],
    })
    const relearned = await call('POST', `/projects/${project.id}/lessons`, {
      title: '价格一律用整数分',
      rule: '格式化统一走 src/utils/money.ts',
    })
    assert.equal(relearned.lessons.length, 2, '同名的规则更新原来那条')
    assert.equal(relearned.lessons[0].rule, '格式化统一走 src/utils/money.ts')
    assert.equal(relearned.lessons[0].source, 'user')
    const emptyLesson = await call('POST', `/projects/${project.id}/lessons`, { title: ' ' }).catch((e) => e)
    assert.ok(emptyLesson instanceof Error, '空规则不能记')
    // 不带 lessons 的项目设置请求不清空教训
    const { lessons: _lessons, ...withoutLessons } = projectInput
    const kept = await call('PUT', `/projects/${project.id}`, withoutLessons)
    assert.equal(kept.lessons.length, 2)
    // 全局教训：没确认不能写；写进去后新会话的提示里排在项目教训后面
    const unconfirmed = await call('PUT', '/global-lessons', { lessons: [] }).catch((e) => e)
    assert.ok(unconfirmed instanceof Error, '没确认不能改全局教训')
    await call('PUT', '/global-lessons', {
      confirmed: true,
      lessons: [{ id: 'g-e2e', title: '等待用后台命令', rule: '不用会立刻退出的定时脚本' }],
    })
    assert.equal((await call('GET', '/global-lessons')).length, 1)
    const learned = await waitDone(
      (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '看看教训' })).id,
      20000,
    )
    const lessonLog = JSON.stringify(calls().at(-1))
    assert.ok(lessonLog.includes('## 项目教训'), '新会话带上项目教训')
    assert.ok(lessonLog.includes('格式化统一走 src/utils/money.ts'), '所有改动都适用的给全文')
    assert.ok(lessonLog.includes('支付方式写进配置'), '按文件的列标题')
    assert.ok(!lessonLog.includes('下单流程只读配置字段'), '按文件的全文不放进提示，按需用工具取')
    assert.ok(lessonLog.includes('不用会立刻退出的定时脚本'), '全局教训也带上')
    assert.ok(
      lessonLog.indexOf('格式化统一走') < lessonLog.indexOf('不用会立刻退出的定时脚本'),
      '全局教训排在项目教训后面',
    )
    await call('PUT', '/global-lessons', { confirmed: true, lessons: [] })
    await call('DELETE', `/tasks/${learned.id}`)
    await call('PUT', `/projects/${project.id}`, { ...projectInput, lessons: [] })
    step('项目教训：接口记录和同名更新，新会话的提示只带全局条目全文和其余标题')
  }

  // ---- 中断恢复：执行到一半停止，继续执行时续接那个节点的会话，从中断的地方接着做 ----
  let half = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'SLOW 中断恢复' })
  await sleep(800)
  await call('POST', `/tasks/${half.id}/stop`)
  half = await waitDone(half.id, 8000)
  assert.equal(half.status, 'stopped')
  const cut = half.steps.find((s) => s.interrupted)
  assert.ok(
    cut,
    '正在跑的节点记为被打断 ' + JSON.stringify([half.steps.map((s) => [s.id, s.status, s.interrupted]), half.sessions]),
  )
  assert.ok(half.sessions[cut.id], '被打断的节点留着会话')
  assert.equal(half.messages.at(-1).transient, true, '结束时写的暂停说明是临时的')
  const beforeResume = calls().length
  await call('POST', `/tasks/${half.id}/resume`)
  half = await waitDone(half.id, 20000)
  assert.equal(half.status, 'done', JSON.stringify(half.messages.filter((m) => m.role === 'system')))
  const cont = calls().slice(beforeResume)[0]
  assert.match(cont.input, /从中断的地方接着完成本节点/)
  assert.ok(!half.steps.some((s) => s.interrupted))
  assert.ok(!half.messages.some((m) => m.transient), '继续执行后去掉暂停说明，输出接在同一个节点里')
  step('中断恢复：停止后继续执行，被打断的节点续接会话接着做')

  // ---- 工作流执行中补充信息：交给正在跑的节点（收不了时留给下一个节点），不算新要求 ----
  {
    let w = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'SLOW 工作流补充' })
    await sleep(1000)
    const before = calls().length
    w = await call('POST', `/tasks/${w.id}/messages`, { text: '接口要兼容旧版' })
    const note = w.messages.find((m) => m.text === '接口要兼容旧版')
    assert.ok(note?.step, '补充记在正在跑的节点上')
    w = await waitDone(w.id, 20000)
    assert.equal(w.status, 'done')
    const got =
      readLog(`${log}.steer`).some((x) => x.steered.some((s) => s.includes('接口要兼容旧版'))) ||
      calls()
        .slice(before)
        .some((c) => c.input.includes('用户在执行中补充的信息') && c.input.includes('接口要兼容旧版'))
    assert.ok(got, 'Agent 收到了补充的信息')
  }
  step('工作流执行中补充信息：交给正在跑的节点，接着当前的任务做')

  // ---- 对话中途换 CLI 和模型：下一轮生效；换了 CLI 开新会话，把之前的对话带过去；每条回复记下自己用的 CLI ----
  {
    let c = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'codex',
      prompt: '记住暗号是蓝鲸',
    })
    c = await waitDone(c.id)
    assert.equal(c.messages.findLast((m) => m.role === 'agent').run?.cli, 'codex')
    c = await call('PATCH', `/tasks/${c.id}`, { cli: 'claude', model: '', effort: '' })
    assert.equal(c.cli, 'claude')
    const before = calls().length
    await call('POST', `/tasks/${c.id}/messages`, { text: '暗号是什么' })
    c = await waitDone(c.id)
    assert.equal(c.status, 'done')
    const next = calls().slice(before)[0]
    assert.equal(next.kind, 'claude', '换了 CLI 后下一轮用新的 CLI')
    assert.ok(!next.args.includes('--resume'), '换了 CLI 开新会话')
    assert.match(next.input, /之前的对话[\s\S]*蓝鲸/, '把之前的对话带给新会话')
    assert.equal(c.messages.findLast((m) => m.role === 'agent').run?.cli, 'claude')
    const bad = await fetch(`${base}/tasks/${t.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli: 'claude' }),
    })
    assert.equal(bad.status, 400, '工作流任务不能换 CLI')
  }
  step('对话中途换 CLI：下一轮生效，开新会话并带上之前的对话')

  // ---- 权限请求：Claude Code 要确认的命令和问题显示在任务上，用户回答后交回 CLI ----
  let ask = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'ASK 需要确认',
    askUser: true,
  })
  const waitReq = async () => {
    for (let i = 0; i < 100; i++) {
      const t = await call('GET', `/tasks/${ask.id}`)
      if (t.requests.length) return t.requests[0]
      await sleep(100)
    }
    throw new Error('没有等到请求')
  }
  const r1 = await waitReq()
  assert.equal(r1.kind, 'command')
  assert.match(r1.title, /rm -rf build/)
  await call('POST', `/tasks/${ask.id}/requests/${r1.id}`, { allow: true })
  const r2 = await waitReq()
  assert.equal(r2.kind, 'question')
  assert.deepEqual(r2.options, ['SQLite', 'MySQL'])
  assert.deepEqual(
    r2.questions.map((q) => [q.header, q.options.length]),
    [
      ['数据库', 2],
      ['缓存', 2],
    ],
    '一次问的几个问题都带上',
  )
  await call('POST', `/tasks/${ask.id}/requests/${r2.id}`, { allow: true, answers: ['SQLite', '用 Redis'] })
  await assert.rejects(call('POST', `/tasks/${ask.id}/requests/${r2.id}`, { allow: true }), /已经结束/)
  ask = await waitDone(ask.id)
  assert.equal(ask.status, 'done')
  assert.equal(ask.requests.length, 0)
  const [a1, a2] = readLog(log + '.ask').at(-1)
  assert.equal(a1.behavior, 'allow')
  assert.equal(a1.updatedInput.command, 'rm -rf build')
  assert.equal(a2.updatedInput.answers['用哪个数据库？'], 'SQLite')
  assert.equal(a2.updatedInput.answers['要不要加缓存？'], '用 Redis', '几个问题的回答一起交回去')
  assert.ok(ask.messages.some((m) => m.role === 'system' && /你允许了：运行命令：rm -rf build/.test(m.text)))
  // 回答带上每个问题和答案，页面在对话正文里显示
  assert.deepEqual(ask.messages.find((m) => m.answers)?.answers, [
    { question: '用哪个数据库？', answer: 'SQLite' },
    { question: '要不要加缓存？', answer: '用 Redis' },
  ])
  step('权限请求：命令和问题在任务上等用户确认，回答后交回 CLI')

  // 「提问」开关关着：审批照样等用户，问题不交给用户，让 CLI 自己选
  ask = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'ASK 自己选' })
  assert.equal(ask.askUser, false)
  const r3 = await waitReq()
  assert.equal(r3.kind, 'command')
  await call('POST', `/tasks/${ask.id}/requests/${r3.id}`, { allow: false })
  ask = await waitDone(ask.id)
  assert.equal(ask.status, 'done')
  const [d1, d2] = readLog(log + '.ask').at(-1)
  assert.equal(d1.behavior, 'deny')
  assert.equal(d2.behavior, 'deny')
  assert.match(d2.message, /自己的判断|不要再提问/, '问题让 CLI 自己选')
  step('提问开关关着：审批照样等用户，问题让 CLI 自己选最合适的做法')

  // ---- 工作流的条件连线、完成后等我确认、预算上限 ----
  const wfBranch = await call('POST', '/workflows', {
    name: '条件分支',
    description: '',
    mainAgentId: A.id,
    members: [],
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          node('t', '测试', '', '跑测试。', { hooks: { confirm: true } }),
          node('ok', '发布', '', '发布。'),
          node('fix', '修复', '', '修复失败的测试。'),
          node('after', '收尾', '', '收尾。'),
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't' },
          { id: 'e2', from: 't', to: 'ok', when: 'pass' },
          { id: 'e3', from: 't', to: 'fix', when: 'fail' },
          { id: 'e4', from: 'ok', to: 'after' },
          { id: 'e5', from: 'fix', to: 'end' },
          { id: 'e6', from: 'after', to: 'end' },
        ],
      },
    ],
    entryFlowId: 'main',
    document: '',
  })
  const nBranch = calls().length
  let br = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'workflow',
    workflowId: wfBranch.id,
    prompt: 'BRANCHNO 跑一遍',
  })
  const waitConfirm = async (id) => {
    for (let i = 0; i < 100; i++) {
      const tk = await call('GET', `/tasks/${id}`)
      if (tk.requests.length) return tk.requests[0]
      await sleep(100)
    }
    throw new Error('没有等到确认')
  }
  const cf1 = await waitConfirm(br.id)
  assert.equal(cf1.kind, 'confirm')
  assert.match(cf1.title, /「测试」完成了/)
  assert.match(cf1.detail, /结论：不通过/, '确认卡片上是节点的结果')
  await call('POST', `/tasks/${br.id}/requests/${cf1.id}`, { allow: false, answer: '多跑一遍集成测试 BRANCHNO' })
  const cf2 = await waitConfirm(br.id)
  const redo = calls().slice(nBranch).at(-1)
  assert.match(redo.input, /用户看了结果，要求修改：\n多跑一遍集成测试 BRANCHNO/, '退回的意见交回节点')
  assert.match(redo.input, /结论：通过」或「结论：不通过/, '返工后同样要给出结论')
  await call('POST', `/tasks/${br.id}/requests/${cf2.id}`, { allow: true })
  br = await waitDone(br.id)
  assert.equal(br.status, 'done', JSON.stringify(br.messages.filter((m) => m.role === 'system')))
  const byNode = (id) => br.steps.find((s) => s.nodeId === id)
  assert.equal(byNode('t').branch, 'fail')
  assert.equal(byNode('fix').status, 'done', '结论不通过：走修复')
  assert.equal(byNode('ok').status, 'skipped', '没走到的分支跳过')
  assert.equal(byNode('after').status, 'skipped', '跳过的节点后面的也跳过')
  const first = calls()[nBranch]
  assert.match(first.input, /通过时接着做「发布」；不通过时接着做「修复」/)
  assert.ok(br.messages.some((m) => /你退回了「测试」：多跑一遍集成测试 BRANCHNO/.test(m.text)))
  assert.ok(br.messages.some((m) => /你确认了「测试」的结果/.test(m.text)))

  // 流程停在门禁上（结论不通过、只有「通过」的线）：追加要求交给主 Agent 处理，处理完从门禁重新检查、接着走流程
  {
    const wfGate = await call('POST', '/workflows', {
      name: '门禁',
      description: '',
      mainAgentId: A.id,
      members: [],
      flows: [
        {
          id: 'main',
          name: '主流程',
          nodes: [node('g', '前置检查', '', '检查环境。'), node('go', '设计', '', '出设计。')],
          edges: [
            { id: 'e1', from: 'start', to: 'g' },
            { id: 'e2', from: 'g', to: 'go', when: 'pass' },
            { id: 'e3', from: 'go', to: 'end' },
          ],
        },
      ],
      entryFlowId: 'main',
      document: '',
    })
    const gateOf = (tk, id) => tk.steps.find((s) => s.nodeId === id)
    let gt = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'workflow',
          workflowId: wfGate.id,
          prompt: 'BRANCHNO 门禁',
        })
      ).id,
    )
    assert.equal(gateOf(gt, 'g').branch, 'fail')
    assert.equal(gateOf(gt, 'go').status, 'skipped')
    assert.ok(
      gt.messages.some((m) => /流程停在「前置检查」/.test(m.text)),
      '停在门禁时说明怎么继续',
    )
    const nGate = calls().length
    gt = await call('POST', `/tasks/${gt.id}/messages`, { text: 'GATEFIXED 帮我修好门禁' })
    gt = await waitDone(gt.id)
    const fixCall = calls()[nGate]
    assert.match(fixCall.input, /工作流停在了节点「前置检查」/, '追加要求先交给主 Agent 处理停住的问题')
    assert.equal(gateOf(gt, 'g').branch, 'pass', '处理完从门禁重新检查')
    assert.equal(gateOf(gt, 'go').status, 'done', '门禁通过后接着走后面的流程')
    assert.equal(gt.status, 'done')

    // 「继续流程」：不加新要求，从门禁重新检查；「结束流程」：没完成的节点不再执行
    let g2 = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'workflow',
          workflowId: wfGate.id,
          prompt: 'BRANCHNO 再来',
        })
      ).id,
    )
    const nResume = calls().length
    g2 = await waitDone((await call('POST', `/tasks/${g2.id}/resume`)).id)
    assert.ok(calls().length > nResume, '继续流程时重新执行门禁')
    assert.equal(gateOf(g2, 'g').branch, 'fail')
    g2 = await call('POST', `/tasks/${g2.id}/end-flow`)
    assert.equal(g2.flowClosed, true)
    assert.equal(gateOf(g2, 'go').status, 'skipped')
    await assert.rejects(call('POST', `/tasks/${g2.id}/resume`), /400/, '结束的流程不能再继续')
    // 工作流的输入框也能用「/命令」：按默认 CLI 展开成普通的要求，对话里显示原文
    const nInit = calls().length
    g2 = await waitDone((await call('POST', `/tasks/${g2.id}/messages`, { text: '/init' })).id)
    const um = g2.messages.filter((m) => m.role === 'user').at(-1)
    assert.equal(um.text, '/init')
    assert.match(um.prompt, /AGENTS\.md/)
    assert.match(calls()[nInit].input, /用户已经结束了工作流/)
    assert.match(calls()[nInit].input, /请分析这个项目/)
    assert.equal(gateOf(g2, 'g').branch, 'fail', '结束流程后追加要求不再重跑门禁')
    step('流程停在门禁：追加要求处理完自动接着走；可以继续流程、结束流程；工作流支持「/命令」')
  }

  // 预算：第一个节点用掉的 token 超过上限，第二个节点开始前暂停；继续执行再给一份额度
  const wfBudget = await call('POST', '/workflows', {
    name: '有预算',
    description: '',
    mainAgentId: A.id,
    members: [],
    budgetTokens: 1,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [node('a', '一', '', '做一。'), node('b', '二', '', '做二。')],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'b' },
          { id: 'e3', from: 'b', to: 'end' },
        ],
      },
    ],
    entryFlowId: 'main',
    document: '',
  })
  let bud = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'workflow',
    workflowId: wfBudget.id,
    prompt: '省着点',
  })
  bud = await waitDone(bud.id)
  assert.equal(bud.status, 'stopped')
  assert.match(bud.messages.at(-1).text, /达到工作流设定的上限 1，已暂停/)
  assert.equal(bud.steps.find((s) => s.nodeId === 'a').status, 'done')
  assert.notEqual(bud.steps.find((s) => s.nodeId === 'b')?.status, 'done')
  await call('POST', `/tasks/${bud.id}/resume`, {})
  bud = await waitDone(bud.id)
  assert.equal(bud.status, 'done', '继续执行时重新给一份额度')
  assert.ok(!bud.messages.some((m) => m.transient), '继续执行后去掉达到上限的暂停说明')
  await call('DELETE', `/tasks/${br.id}`)
  await call('DELETE', `/tasks/${bud.id}`)
  await call('DELETE', `/workflows/${wfBranch.id}`)
  await call('DELETE', `/workflows/${wfBudget.id}`)
  step('工作流：条件连线按结论选路，完成后等我确认（可以退回），超过预算上限暂停')

  // ---- 工作流不再有常驻编排器：节点直接执行，条件分支看节点自己的结论 ----
  {
    const wfMain = await call('POST', '/workflows', {
      name: '没有编排器的工作流',
      description: '',
      mainAgentId: A.id,
      // 旧字段，升级后也不会再生成 @main
      dispatch: true,
      flows: [
        {
          id: 'main',
          name: '主流程',
          nodes: [
            node('d1', '实现', B.id, 'MAINREWORK 写代码。'),
            node('d2', '自己看一眼', '', '看一眼。'),
            node('d3', '测试', C.id, 'BRANCHNO 跑测试。'),
            node('ok', '发布', '', '发布。'),
            node('fix', '修复', B.id, '修复。'),
          ],
          edges: [
            { id: 'e1', from: 'start', to: 'd1' },
            { id: 'e2', from: 'd1', to: 'd2' },
            { id: 'e3', from: 'd2', to: 'd3' },
            { id: 'e4', from: 'd3', to: 'ok', when: 'pass' },
            { id: 'e5', from: 'd3', to: 'fix', when: 'fail' },
            { id: 'e6', from: 'ok', to: 'end' },
            { id: 'e7', from: 'fix', to: 'end' },
          ],
        },
      ],
      entryFlowId: 'main',
      document: '',
    })
    const n0 = calls().length
    let dm = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'workflow',
      workflowId: wfMain.id,
      prompt: '没有编排器跑一遍',
    })
    assert.equal(dm.steps[0].id, 'd1', '不再生成 @main，直接是第一个节点')
    dm = await waitDone(dm.id)
    assert.equal(dm.status, 'done', JSON.stringify(dm.messages.filter((m) => m.role === 'system')))
    const by = (id) => dm.steps.find((s) => s.id === id)
    assert.ok(!dm.steps.some((s) => s.kind === 'main'), '没有常驻编排器')
    assert.equal(by('d3').branch, 'fail', '分支由节点自己的结论决定')
    assert.equal(by('fix').status, 'done')
    assert.equal(by('ok').status, 'skipped')
    assert.ok(!by('d3/call.1/c1'), '不再有主 Agent 委派')
    const mine = calls().slice(n0)
    assert.ok(!mine.some((c) => /## 事件：/.test(c.input)), '节点之间不经过主 Agent')
    assert.ok(!mine.some((c) => /常驻编排器/.test(c.input)), '提示词里没有编排器')
    assert.equal(mine.filter((c) => /本节点「实现」|继续完善本节点「实现」/.test(c.input)).length, 1, '节点只执行一次')
    // 节点仍然带编排工具，可以派子 Agent、传话、读写共享状态
    assert.ok(
      mine.every((c) => c.args.some((x) => x.includes('/api/mcp/ask/'))),
      '节点都接上编排工具',
    )
    assert.match(mine.find((c) => /节点：修复/.test(c.input)).input, /spawn_agents 派子任务/)
    // 追加要求交给工作流的默认执行 Agent（不再有 @main 会话）
    const n1 = calls().length
    await call('POST', `/tasks/${dm.id}/messages`, { text: '再改一下' })
    dm = await waitDone(dm.id)
    const follow = calls()[n1]
    assert.match(follow.input, /再改一下/)
    await call('DELETE', `/workflows/${wfMain.id}`)
  }
  step('工作流没有再常驻编排器：节点直接执行、自己的结论决定分支，追加要求交给默认执行 Agent')

  // ---- 失败 ----
  let bad = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'FAIL 请失败' })
  bad = await waitDone(bad.id)
  assert.equal(bad.status, 'failed')
  assert.match(bad.messages.at(-1).text, /Claude Code 执行失败[\s\S]*模拟的失败/)
  let badWf = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'FAIL 工作流' })
  badWf = await waitDone(badWf.id)
  assert.equal(badWf.status, 'failed')
  assert.deepEqual(
    badWf.steps.map((s) => s.status),
    ['failed', 'pending', 'pending', 'pending'],
  )
  const failedStep = badWf.steps.find((s) => s.status === 'failed')
  const stepErr = badWf.messages.find((m) => m.step === failedStep.id && m.role === 'system')
  assert.ok(stepErr?.error && /模拟的失败/.test(stepErr.text), '错误写进失败的节点里')
  const tail = badWf.messages.at(-1)
  assert.ok(
    tail.error && /原因见节点里的错误/.test(tail.text) && !/模拟的失败/.test(tail.text),
    '结尾只提一句，不重复整段',
  )
  // 连接中途断开：有会话就自动续接；一直断就给出能照着做的说明
  let net = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    prompt: 'NETFAIL 写个大文件',
  })
  net = await waitDone(net.id)
  assert.equal(net.status, 'done', '断开后自动续接完成')
  c = calls().at(-1)
  assert.ok(c.args.includes('--resume') && /连接中断了/.test(c.input) && /分几次写/.test(c.input))
  // 续接成功后，断开时的报错收成普通说明：这一轮实际没有失败，不能一直挂着一张红色错误
  const shown = net.messages.find((m) => m.role === 'system' && /已自动续接会话（第 1 次）/.test(m.text))
  assert.ok(shown && /Unable to connect to the API/.test(shown.text), '断开的原因要留着能查')
  assert.ok(!shown.error && shown.transient, '续接成功后不再显示成错误')
  net = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    prompt: 'NETDOWN 写个大文件',
  })
  net = await waitDone(net.id)
  assert.equal(net.status, 'failed')
  const netErr = net.messages.at(-1)
  assert.ok(netErr.error)
  assert.match(netErr.text, /已自动续接 2 次，仍然失败/)
  assert.equal(
    net.messages.filter((m) => m.error && /正在自动续接会话重试/.test(m.text)).length,
    2,
    '每次续接前的报错都显示',
  )
  assert.match(netErr.text, /走的是 Command Code 官方服务[\s\S]*me\/fake\/flash/)
  assert.match(netErr.text, /连接中途断开/)
  // 运行日志：程序目录的 logs/ 里，这次启动一个文件，记下了启动、CLI 的命令和断开重试
  const logUsage = await call('GET', '/data')
  assert.ok(
    logUsage.logs?.current && logUsage.logs.current.startsWith(path.join(appDir, 'logs')),
    '日志在单独的文件夹里',
  )
  const logText = readFileSync(logUsage.logs.current, 'utf8')
  assert.match(logText, /INFO  \[server\] 启动/)
  assert.match(logText, /\[agent\] 启动 Command Code[\s\S]*command: /)
  assert.match(logText, /WARN  \[agent\] Command Code 连接中断，自动续接第 1 次/)
  assert.match(logText, /ERROR \[agent\] Command Code 执行失败/)
  step('失败：显示 CLI 报告的错误，工作流停在失败的节点')
  // 卡住的 CLI：没有输出先提醒一次，再过同样的时间自动停止；输出里看出是没登录，给出登录的方法
  await call('PUT', '/settings', { ...settings, idleTimeoutMinutes: 1 })
  let hang = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'HANG' })
  hang = await waitDone(hang.id)
  await call('PUT', '/settings', settings)
  assert.equal(hang.status, 'failed')
  assert.ok(
    hang.messages.some((m) => m.role === 'system' && /已经 1 分钟没有任何输出/.test(m.text)),
    '先提醒一次',
  )
  assert.match(hang.messages.at(-1).text, /连续 2 分钟没有任何输出，已停止/)
  assert.match(hang.messages.at(-1).text, /没有登录[\s\S]*\/login/)
  step('卡住的 CLI：长时间没有输出先提醒、再自动停止，看出没登录时说明怎么登录')

  // ---- 节点入口：开始 / 验收 / 结束，流程节点，引用其他工作流 ----
  const small = await call('POST', '/workflows', {
    name: '小流程',
    mainAgentId: A.id,
    members: [],
    entryFlowId: 'main',
    document: '',
    flows: [
      flow(
        'main',
        '',
        [node('s', '小流程节点', '', '小流程要做的事。')],
        [
          ['start', 's'],
          ['s', 'end'],
        ],
      ),
    ],
  })
  const hooked = await call('POST', '/workflows', {
    name: '带入口',
    mainAgentId: A.id,
    members: [
      { agentId: B.id, responsibility: '' },
      { agentId: C.id, responsibility: '' },
    ],
    entryFlowId: 'main',
    document: '',
    flows: [
      flow(
        'main',
        '主流程',
        [
          node('x', '实现功能', B.id, '实现它。', {
            hooks: {
              start: { kind: 'sub', id: 'prep' },
              review: { kind: 'sub', id: 'rv' },
              end: { kind: 'sub', id: 'post' },
              maxRounds: 3,
            },
          }),
          node('y', '跑小流程', '', '', { kind: 'flow', flow: { kind: 'workflow', id: small.id } }),
        ],
        [
          ['start', 'x'],
          ['x', 'y'],
          ['y', 'end'],
        ],
      ),
      flow(
        'prep',
        '准备',
        [node('p', '收集资料', C.id, '收集资料。')],
        [
          ['start', 'p'],
          ['p', 'end'],
        ],
      ),
      flow(
        'rv',
        '验收',
        [node('r', '审查', '', '审查改动。')],
        [
          ['start', 'r'],
          ['r', 'end'],
        ],
      ),
      flow(
        'post',
        '收尾',
        [node('q', '写说明', C.id, '写变更说明。')],
        [
          ['start', 'q'],
          ['q', 'end'],
        ],
      ),
    ],
  })
  await call('PUT', `/projects/${project.id}`, { ...project, workflowId: hooked.id })
  const before2 = calls().length
  let h = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '带入口的任务' })
  h = await waitDone(h.id)
  assert.equal(h.status, 'done', JSON.stringify(h.messages.filter((m) => m.role === 'system')))
  assert.deepEqual(
    h.steps.map((s) => [s.id, s.status]),
    [
      ['x', 'done'],
      ['y', 'done'],
      ['x/start/p', 'done'],
      ['x/review.1/r', 'done'],
      ['x/review.2/r', 'done'],
      ['x/end/q', 'done'],
      ['y/body/s', 'done'],
    ],
  )
  const x = h.steps.find((s) => s.id === 'x')
  assert.equal(x.rounds, 2)
  assert.equal(x.verdict, 'pass')
  assert.match(x.output, /结束流程的结果/)
  const hc = calls().slice(before2)
  assert.deepEqual(
    hc.map((k) => k.kind),
    // 节点都用默认 CLI（claude）执行
    Array(7).fill('claude'),
  )
  assert.match(hc[1].input, /开始流程的结果[\s\S]*的回复/)
  assert.match(hc[2].input, /实现功能」的验收流程（第 1 轮验收）[\s\S]*验收结论/)
  assert.ok(hc[3].args.includes('--resume'), '验收不通过后续接节点的会话继续完善')
  assert.match(hc[3].input, /验收没有通过（第 1 轮）[\s\S]*验收结论：不通过/)
  assert.match(hc[4].input, /第 2 轮验收/)
  // 第 2 轮验收续接第 1 轮验收的会话，只交修改后的结果，不再重复整段需求
  assert.equal(hc[4].args[hc[4].args.indexOf('--resume') + 1], h.sessions['x/review.1/r'], '验收续接上一轮的会话')
  assert.ok(!/## 用户需求/.test(hc[4].input) && /修改后的结果/.test(hc[4].input))
  assert.match(hc[6].input, /工作流「小流程」[\s\S]*上游节点的结果|工作流「小流程」[\s\S]*## 输入/)
  assert.ok(h.messages.some((m) => m.role === 'system' && /第 1 轮验收未通过/.test(m.text)))
  assert.ok(
    h.messages.some((m) => m.step === 'x/review.1/r'),
    '子节点的消息记在子节点上',
  )
  // 验收轮数用完仍不通过时节点失败
  await call('PUT', `/workflows/${hooked.id}`, {
    ...hooked,
    flows: hooked.flows.map((f) =>
      f.id !== 'main'
        ? f
        : {
            ...f,
            nodes: f.nodes.map((n) =>
              n.id === 'x' ? { ...n, hooks: { ...n.hooks, start: null, end: null, maxRounds: 1 } } : n,
            ),
          },
    ),
  })
  let h2 = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '只验收一轮' })
  h2 = await waitDone(h2.id)
  assert.equal(h2.status, 'failed')
  assert.match(
    h2.messages
      .filter((m) => m.error)
      .map((m) => m.text)
      .join('\n'),
    /验收 1 轮仍未通过/,
  )
  assert.deepEqual(
    h2.steps.filter((s) => !s.parentId).map((s) => s.status),
    ['failed', 'pending'],
  )
  // 保存时拦下有问题的流程图：自己调用自己、节点连成环
  await assert.rejects(
    call('POST', '/workflows', {
      name: '自引用',
      mainAgentId: A.id,
      members: [],
      entryFlowId: 'main',
      document: '',
      flows: [
        flow(
          'main',
          '',
          [node('z', '套娃', '', '', { kind: 'flow', flow: { kind: 'sub', id: 'main' } })],
          [
            ['start', 'z'],
            ['z', 'end'],
          ],
        ),
      ],
    }),
    /循环调用/,
  )
  await assert.rejects(
    call('POST', '/workflows', {
      name: '成环',
      mainAgentId: A.id,
      members: [],
      entryFlowId: 'main',
      document: '',
      flows: [
        flow(
          'main',
          '',
          [node('p', '甲', ''), node('q', '乙', '')],
          [
            ['start', 'p'],
            ['p', 'q'],
            ['q', 'p'],
          ],
        ),
      ],
    }),
    /连成了环/,
  )
  await call('PUT', `/projects/${project.id}`, { ...project, workflowId: wf.id })
  step('节点入口：开始流程的结果交给节点，验收不通过退回完善、轮数用完失败，结束流程、流程节点、引用其他工作流都能执行')

  // ---- 系统默认 CLI 和模型档位 ----
  await call('PUT', '/settings', {
    ...settings,
    defaultCli: 'codex',
    clis: { ...settings.clis, codex: cli({ tiers: { high: 'gpt-top', medium: '', low: '' } }) },
  })
  const D = await agent({ name: '默认', cli: '', model: '@high' })
  const L = await agent({ name: '低档', cli: 'claude', model: '@low' })
  assert.equal((await call('GET', '/clis')).find((x) => x.isDefault).id, 'codex')
  for (const [ag, kind, flag, model] of [
    [D, 'codex', '-c', 'model="gpt-top"'],
    // Claude 设置了默认模型 sonnet，低档没填就跟随默认模型
    [L, 'claude', '--model', 'sonnet'],
  ]) {
    let t2 = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: ag.id, prompt: '档位' })
    t2 = await waitDone(t2.id)
    assert.equal(t2.status, 'done', JSON.stringify(t2.messages.at(-1)))
    const k = calls().at(-1)
    assert.equal(k.kind, kind)
    assert.equal(k.args[k.args.indexOf(flag) + 1], model)
    if (kind === 'codex') assert.ok(k.args.includes('model_reasoning_effort="high"'), '档位带上思考强度')
    else assert.equal(k.args[k.args.indexOf('--effort') + 1], 'low')
  }
  // 中档没填时用内置建议值
  await call('PUT', '/agents/' + D.id, { ...D, model: '@medium' })
  let t3 = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: D.id, prompt: '档位' })
  t3 = await waitDone(t3.id)
  assert.ok(calls().at(-1).args.includes('model="gpt-6.1-sol"'))
  // 跟随默认 CLI 的 Agent：默认 CLI 换成 Command Code 后跟着换，档位换成它的模型，它不支持的思考强度改用档位的
  await call('PUT', '/agents/' + D.id, { ...D, model: '@high', effort: 'xhigh' })
  await call('PUT', '/settings', {
    ...settings,
    defaultCli: 'commandcode',
    clis: {
      ...settings.clis,
      commandcode: cli({ tiers: { high: { model: 'fake/pro', effort: 'high' }, medium: '', low: '' } }),
    },
  })
  await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: D.id, prompt: '跟随' })).id,
  )
  const kf = calls().at(-1)
  assert.equal(kf.kind, 'commandcode')
  assert.equal(kf.args[kf.args.indexOf('-m') + 1], 'fake/pro')
  assert.equal(kf.args[kf.args.indexOf('--effort') + 1], 'high', '不支持的思考强度改用档位的')
  // 设置了具体的默认模型后，没填的档位跟随默认模型
  await call('PUT', '/agents/' + D.id, { ...D, model: '@medium', effort: '' })
  await call('PUT', '/settings', {
    ...settings,
    defaultCli: 'codex',
    clis: {
      ...settings.clis,
      codex: cli({ defaultModel: 'gpt-def', tiers: { high: 'gpt-top', medium: '', low: '' } }),
    },
  })
  t3 = await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: D.id, prompt: '档位' })).id,
  )
  assert.ok(calls().at(-1).args.includes('model="gpt-def"'), '空档位跟随默认模型')
  // Agent 自己的权限覆盖 CLI 设置；换了 CLI 不认的旧值时跟随设置
  await call('PUT', '/agents/' + L.id, { ...L, permission: 'plan' })
  await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: L.id, prompt: '权限' })).id,
  )
  let pk = calls().at(-1).args
  assert.equal(pk[pk.indexOf('--permission-mode') + 1], 'plan', 'Agent 指定的权限')
  await call('PUT', '/agents/' + L.id, { ...L, permission: 'read-only' })
  await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: L.id, prompt: '权限' })).id,
  )
  pk = calls().at(-1).args
  assert.equal(pk[pk.indexOf('--permission-mode') + 1], 'acceptEdits', 'CLI 不支持的权限跟随设置')
  const runWith = async (ag, permission) => {
    await call('PUT', '/agents/' + ag.id, { ...ag, permission })
    await waitDone(
      (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: ag.id, prompt: '权限' })).id,
    )
    return calls().at(-1)
  }
  pk = (await runWith(L, 'default')).args
  assert.equal(pk[pk.indexOf('--permission-mode') + 1], 'default', '逐项确认明确传 default，不沿用 Claude 自己的设置')
  assert.ok(pk.includes('--permission-prompt-tool'), '需要确认的操作交给面板')
  pk = (await runWith(L, 'bypassPermissions')).args
  assert.ok(pk.includes('--dangerously-skip-permissions') && !pk.includes('--permission-prompt-tool'), '跳过所有确认')
  await call('PUT', '/agents/' + L.id, { ...L, permission: '' })
  let ck = await runWith(B, 'danger-full-access')
  assert.deepEqual([ck.approval, ck.sandbox], ['never', 'danger-full-access'], 'Codex 完全访问：不用沙箱、不确认')
  assert.ok(ck.args.includes('approval_policy="never"') && ck.args.includes('sandbox_mode="danger-full-access"'))
  ck = await runWith(B, 'read-only')
  assert.deepEqual([ck.approval, ck.sandbox], ['on-request', 'read-only'], 'Codex 只读')
  await call('PUT', '/agents/' + B.id, { ...B, permission: '' })
  await call('PUT', '/settings', settings)

  // ---- 附件和 @ 引用项目文件 ----
  const att = await call('POST', '/uploads', {
    name: '截图.png',
    mime: 'image/png',
    data: Buffer.from('png!').toString('base64'),
  })
  assert.equal(att.size, 4)
  assert.ok(att.path.startsWith(path.join(dataDir, 'uploads')), '附件存在数据目录里')
  const rawRes = await fetch(`${base}/uploads/raw?path=${encodeURIComponent(att.path)}`)
  assert.equal(rawRes.headers.get('content-type'), 'image/png')
  assert.equal(await rawRes.text(), 'png!')
  assert.equal(
    (await fetch(`${base}/uploads/raw?path=${encodeURIComponent(path.join(projectDir, 'README.md'))}`)).status,
    400,
    '不能读附件目录以外的文件',
  )
  let tAtt = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: L.id,
    prompt: '看看这张图',
    attachments: [att],
  })
  tAtt = await waitDone(tAtt.id)
  assert.deepEqual(
    tAtt.messages[0].attachments.map((a) => a.name),
    ['截图.png'],
  )
  assert.equal(tAtt.messages[0].text, '看看这张图', '附件不写进消息正文')
  const kAtt = calls().at(-1)
  assert.match(kAtt.input, /## 附件[\s\S]*截图\.png：/)
  assert.equal(kAtt.args[kAtt.args.indexOf('--add-dir') + 1], path.join(dataDir, 'uploads'))
  assert.deepEqual(await call('GET', `/projects/${project.id}/files?q=read`), ['README.md'])
  // 文件浏览：根信息不带全量文件，列一层才读一层，名称搜索能搜到还没展开的深层文件
  {
    mkdirSync(path.join(projectDir, 'src/api'), { recursive: true })
    writeFileSync(path.join(projectDir, 'src/api/deep-cart.ts'), 'export {}\n')
    const info = await call('GET', `/project-files/${project.id}`)
    assert.deepEqual(Object.keys(info).sort(), ['branch', 'dir', 'isGit'], '根信息不再返回全量文件')
    const root = await call('GET', `/project-files/${project.id}/list`)
    assert.ok(
      root.entries.some((e) => e.name === 'src' && e.kind === 'dir'),
      JSON.stringify(root.entries),
    )
    assert.ok(root.entries.some((e) => e.name === 'README.md' && e.kind === 'file'))
    assert.ok(!root.entries.some((e) => e.path.includes('/')), '第一层不展开子目录')
    // 未展开的深层文件也能按名字搜到
    const found = await call('GET', `/project-files/${project.id}/search?mode=name&q=deep-cart`)
    assert.deepEqual(
      found.files.map((f) => f.path),
      ['src/api/deep-cart.ts'],
    )
    // 未跟踪的文件带 ? 状态；越权路径按错误返回
    assert.equal(found.files[0].status, '?')
    const level = await call('GET', `/project-files/${project.id}/list?path=src`)
    assert.equal(level.entries.find((e) => e.path === 'src/api').kind, 'dir')
    const escaped = await fetch(`${base}/project-files/${project.id}/list?path=${encodeURIComponent('../..')}`)
    assert.equal(escaped.status, 404, '不能列到项目目录外面')
    // 任务目录同样按层读
    const tLevel = await call('GET', `/tasks/${tAtt.id}/files/list`)
    assert.ok(tLevel.entries.some((e) => e.name === 'README.md'))
    const tInfo = await call('GET', `/tasks/${tAtt.id}/files`)
    assert.deepEqual(Object.keys(tInfo).sort(), ['branch', 'dir', 'isGit'])
    // 在系统里打开：文件、目录、空路径（项目目录）都接受，越权路径被拒绝
    // （测试环境没有图形界面，只验证参数校验和返回，实际打开由 revealItem 静默处理）
    const fileReveal = await call('POST', `/project-files/${project.id}/reveal?path=README.md`, {})
    assert.equal(fileReveal.ok, true)
    const dirReveal = await call('POST', `/project-files/${project.id}/reveal?path=src`, {})
    assert.equal(dirReveal.ok, true)
    const rootReveal = await call('POST', `/project-files/${project.id}/reveal`, {})
    assert.equal(rootReveal.ok, true)
    // 越权路径要带 JSON 请求体：不带 content-type 的写请求会先被全局中间件以 415 拒掉
    const badReveal = await fetch(`${base}/project-files/${project.id}/reveal?path=${encodeURIComponent('../..')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(badReveal.status, 404, '不能打开项目目录外面的路径')
    assert.match((await badReveal.json()).error, /只能查看项目目录里的文件/)
    const tReveal = await call('POST', `/tasks/${tAtt.id}/reveal`, { path: 'README.md' })
    assert.equal(tReveal.ok, true)
    const tRootReveal = await call('POST', `/tasks/${tAtt.id}/reveal`, {})
    assert.equal(tRootReveal.ok, true, '任务目录也能整体打开')
  }
  step('文件浏览：只列一层、深层名称搜索、越权路径、任务目录同样按层、在系统里打开')
  // Agent 自己提交了改动：仍然算在任务的更改里（和任务开始时的提交比）
  let tCommit = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'COMMIT 改完提交',
  })
  tCommit = await waitDone(tCommit.id)
  assert.ok(tCommit.baseRef, '记下任务开始时的提交')
  assert.deepEqual(
    tCommit.changes.find((c) => c.path === 'committed.txt'),
    { path: 'committed.txt', add: 3, del: 0 },
    '提交了的改动仍然统计在内 ' + JSON.stringify(tCommit.changes),
  )
  // 看一个文件的差异，撤销它的改动（恢复成任务开始时的样子）
  const d = await call('GET', `/tasks/${tCommit.id}/diff?path=committed.txt`)
  assert.ok(d.git && /\+one\n\+two\n\+three/.test(d.diff), '差异里有新增的行 ' + d.diff)
  const reverted = await call('POST', `/tasks/${tCommit.id}/revert`, { path: 'committed.txt' })
  assert.ok(!existsSync(path.join(projectDir, 'committed.txt')), '任务里新建的文件撤销后删掉')
  assert.ok(!reverted.changes.some((c) => c.path === 'committed.txt'), '撤销后不再算在改动里')
  assert.match(
    await fetch(`${base}/tasks/${tCommit.id}/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../outside.txt' }),
    }).then((r) => r.text()),
    /不在任务的改动里/,
  )
  // 独立分支：在任务自己的 git worktree 里改，项目目录不动；合并后改动才进项目，丢弃则什么都不留
  // 先退掉上面 Agent 自己做的提交，让项目回到干净的起点（committed.txt 已经撤销掉了）
  git('reset', '-q', '--keep', 'HEAD~1')
  let tIso = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'COMMIT BEGIN_EDIT 在独立分支上改',
    isolate: true,
  })
  assert.equal(tIso.worktree, null, '要改文件时才开独立分支')
  tIso = await waitTask(tIso.id, (t) => existsSync(path.join(t.worktree?.path ?? '/nope', 'committed.txt')))
  assert.equal(tIso.worktree?.state, 'active', '建了独立分支')
  assert.ok(existsSync(path.join(tIso.worktree.path, 'committed.txt')), 'Agent 在独立目录里改')
  assert.ok(!existsSync(path.join(projectDir, 'committed.txt')), '项目目录没被改动')
  assert.ok(
    tIso.changes.some((c) => c.path === 'committed.txt'),
    '改动按独立目录统计',
  )
  assert.match((await call('GET', `/tasks/${tIso.id}/diff?path=committed.txt`)).diff, /\+one/)
  writeFileSync(path.join(tIso.worktree.path, 'later.txt'), 'not committed yet\n')
  // 项目里有个没跟踪的同名文件挡着：合并失败，项目和独立分支都保持原样
  const blocker = path.join(projectDir, 'claude-output.txt')
  const blockerText = readFileSync(blocker, 'utf8')
  const blocked = await fetch(`${base}/tasks/${tIso.id}/worktree/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(blocked.status, 409)
  assert.match((await blocked.json()).error, /claude-output\.txt/, '说明是哪个文件挡住了')
  assert.equal((await call('GET', `/tasks/${tIso.id}`)).worktree.state, 'active', '合并失败时独立分支还在')
  assert.ok(!existsSync(path.join(projectDir, 'committed.txt')), '合并失败时项目目录没被改动')
  rmSync(blocker)
  const merged = await call('POST', `/tasks/${tIso.id}/worktree/merge`)
  assert.equal(merged.task.worktree.state, 'active', '合并后分支和目录留着')
  assert.ok(existsSync(tIso.worktree.path), '合并后独立目录还在')
  const status = (await call('GET', `/tasks/${tIso.id}/worktrees`)).items[0]
  assert.ok(status.merged && status.ahead === 0 && status.dirty === 0, '合并后标成已合并')
  assert.ok(existsSync(path.join(projectDir, 'committed.txt')), '合并后改动进了项目目录')
  assert.ok(existsSync(path.join(projectDir, 'later.txt')), '没提交的改动合并前先提交')
  assert.equal(
    readFileSync(path.join(projectDir, 'pre.txt'), 'utf8'),
    'changed before the task\n',
    '项目里原有的改动保留',
  )
  const removed = await call('POST', `/tasks/${tIso.id}/worktree/discard`)
  assert.equal(removed.worktree.state, 'merged', '合并过的分支删除后记成已合并')
  assert.ok(!existsSync(tIso.worktree.path), '删除后独立目录没了')
  assert.equal(git('branch', '--list', tIso.worktree.branch).toString().trim(), '', '删除后任务分支没了')
  // 退回合并前，免得影响后面的测试（--keep 保留 pre.txt 的未提交改动）
  git('reset', '-q', '--keep', 'HEAD~1')
  writeFileSync(blocker, blockerText)
  let tDrop = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'COMMIT BEGIN_EDIT 这个不要了',
    isolate: true,
  })
  tDrop = await waitTask(tDrop.id, (t) => existsSync(path.join(t.worktree?.path ?? '/nope', 'committed.txt')))
  // 状态变成完成的一瞬间，服务端还没把任务从执行中的列表里放掉：等一下再丢弃
  let dropped
  for (let i = 0; ; i++) {
    try {
      dropped = await call('POST', `/tasks/${tDrop.id}/worktree/discard`)
      break
    } catch (e) {
      if (i >= 30 || !/正在执行/.test(e.message)) throw e
      await sleep(100)
    }
  }
  assert.equal(dropped.worktree.state, 'discarded')
  assert.ok(!existsSync(tDrop.worktree.path) && !existsSync(path.join(projectDir, 'committed.txt')), '丢弃后什么都不留')
  assert.equal(git('branch', '--list', tDrop.worktree.branch).toString().trim(), '', '丢弃时删掉任务分支')
  await call('DELETE', `/tasks/${tIso.id}`)
  await call('DELETE', `/tasks/${tDrop.id}`)
  step('独立分支：任务在 git worktree 里执行，合并或丢弃后清理分支和目录')
  // Agent 输出里提到的文件可以点开看：只能读项目目录里的
  const rd = await call('GET', `/tasks/${tCommit.id}/file?path=README.md`)
  assert.equal(rd.content, '# demo\n')
  assert.equal((await call('GET', `/tasks/${tCommit.id}/file?path=nope.ts`)).exists, false)
  assert.equal((await fetch(`${base}/tasks/${tCommit.id}/file?path=../../etc/passwd`)).status, 400)
  // 读到的文件是图片时按原图查看，同样只能读项目目录里的
  writeFileSync(path.join(projectDir, 'shot.png'), PNG_1PX)
  const img = await fetch(`${base}/tasks/${tCommit.id}/file/raw?path=shot.png`)
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG_1PX)
  assert.equal((await fetch(`${base}/tasks/${tCommit.id}/file/raw?path=README.md`)).status, 400, '不是图片不能当图片读')
  assert.equal((await fetch(`${base}/tasks/${tCommit.id}/file/raw?path=../../etc/passwd`)).status, 400)
  // 删除任务时它的附件一起删掉；还在用的附件不会因为时间久了被清理
  const attDir = path.dirname(att.path)
  await call('DELETE', `/tasks/${tAtt.id}`)
  assert.ok(!existsSync(attDir), '删除任务时删掉它的附件')
  // 再传一个还没发出去的附件，后面数据目录的统计要用
  await call('POST', '/uploads', {
    name: '草稿.txt',
    mime: 'text/plain',
    data: Buffer.from('draft').toString('base64'),
  })
  step('附件：上传到数据目录、交给 Agent 读取；@ 能搜到项目里的文件；删除任务时一起删掉')
  // 用户数据目录：旧的平铺文件搬进子目录，按类查看占用、清理缓存，导出再导入原样恢复
  assert.ok(existsSync(path.join(dataDir, 'config/project-categories.json')), '旧的平铺文件搬进 config/')
  assert.ok(!existsSync(path.join(dataDir, 'project-categories.json')))
  // 任务按项目分目录，任务文件里只有用户的消息，完整对话在 .messages.json 里，打开任务时才读
  const legacyFile = path.join(dataDir, 'tasks/projects/legacy-project/legacy-1.json')
  assert.ok(existsSync(legacyFile), '旧的 tasks.json 拆成按项目分目录的任务文件')
  assert.ok(existsSync(path.join(dataDir, 'tasks/projects/legacy-project/legacy-1.messages.json')))
  assert.ok(!existsSync(path.join(dataDir, 'tasks/tasks.json')))
  assert.equal((await call('GET', '/tasks/legacy-1')).messages[0].text, '旧的要求')
  assert.ok(!existsSync(path.join(dataDir, 'tasks/items')), '上一版的 items 目录转换后删掉')
  const chatMeta = JSON.parse(readFileSync(path.join(dataDir, 'tasks/chats/legacy-2.json'), 'utf8'))
  assert.deepEqual(
    chatMeta.messages.map((m) => m.text),
    ['旧的聊天'],
    '任务文件里只放用户消息',
  )
  assert.deepEqual(
    (await call('GET', '/tasks/legacy-2')).messages.map((m) => m.text),
    ['旧的聊天', '旧的回答'],
  )
  assert.equal((await call('GET', '/tasks')).find((x) => x.id === 'legacy-2').messages[0].text, '旧的聊天')
  // 刚跑完的任务：对话在 .messages.json 里
  const wfFile = path.join(dataDir, `tasks/projects/${project.id}/${t.id}.messages.json`)
  assert.ok(JSON.parse(readFileSync(wfFile, 'utf8')).some((m) => m.role === 'agent'))
  const usage = await call('GET', '/data')
  assert.equal(usage.dir, dataDir)
  const kindOf = (u, k) => u.kinds.find((x) => x.id === k)
  assert.ok(kindOf(usage, 'tasks').bytes > 0 && kindOf(usage, 'uploads').files >= 1 && usage.memory.rss > 0)
  // 拆分旧任务文件时，原文件备份在缓存里
  assert.ok(kindOf(usage, 'cache').files >= 1, '旧的 tasks.json 备份在缓存里')
  const cacheBefore = kindOf(usage, 'cache').bytes
  mkdirSync(path.join(dataDir, 'cache/junk'), { recursive: true })
  writeFileSync(path.join(dataDir, 'cache/junk/x.bin'), 'x'.repeat(100))
  assert.equal(kindOf(await call('GET', '/data'), 'cache').bytes, cacheBefore + 100)
  await call('POST', '/data/clear', { kind: 'cache' })
  assert.equal(kindOf(await call('GET', '/data'), 'cache').files, 0, '缓存清理掉了')
  assert.equal(
    (
      await fetch(`${base}/data/clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"kind":"config"}',
      })
    ).status,
    400,
    '配置不能清理',
  )
  const backup = await call('GET', '/data/export?kinds=config,projects,tasks')
  assert.ok(
    backup.files['config/agents.json'] &&
      backup.files['tasks/projects/legacy-project/legacy-1.json'] &&
      !backup.files['uploads'],
  )
  const agentsBefore = await call('GET', '/agents')
  const tasksBefore = (await call('GET', '/tasks')).length
  await call('DELETE', `/agents/${agentsBefore.at(-1).id}`).catch(() => {})
  await call('POST', '/data/clear', { kind: 'tasks' })
  assert.equal((await call('GET', '/tasks')).length, 0, '清理任务记录后马上生效')
  const imported = await call('POST', '/data/import', backup)
  assert.equal(imported.files, Object.keys(backup.files).length)
  assert.deepEqual(
    (await call('GET', '/agents')).map((a) => a.id),
    agentsBefore.map((a) => a.id),
    '导入后 Agent 恢复',
  )
  assert.equal((await call('GET', '/tasks')).length, tasksBefore, '导入后任务记录恢复')
  const evil = { ...backup, kinds: ['tasks'], files: { '../escape.json': 'e30=' } }
  assert.equal(
    (
      await fetch(`${base}/data/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(evil),
      })
    ).status,
    400,
    '不能写到数据目录外',
  )
  assert.ok(!existsSync(path.join(tmp, 'escape.json')))
  step('数据目录：旧文件迁移、占用统计、清理、导出导入')
  // 旧格式（阶段）的工作流自动转换成连线
  const old = await call('POST', '/workflows', {
    name: '旧格式',
    mainAgentId: A.id,
    members: [],
    document: '',
    stages: [
      { id: 's1', title: '', nodes: [{ id: 'o1', title: '一' }] },
      {
        id: 's2',
        title: '',
        nodes: [
          { id: 'o2', title: '二' },
          { id: 'o3', title: '三' },
        ],
      },
    ],
  })
  assert.equal(old.flows.length, 1)
  assert.deepEqual(old.flows[0].edges.map((e) => `${e.from}>${e.to}`).sort(), [
    'o1>o2',
    'o1>o3',
    'o2>end',
    'o3>end',
    'start>o1',
  ])
  step('系统默认 CLI 和模型档位：执行时换成设置里的 CLI 和对应模型和思考强度；Agent 权限覆盖设置；旧格式工作流自动转换')

  // ---- AI 创建 / 优化 ----
  async function assistDone(job) {
    for (let i = 0; job.status === 'running'; i++) {
      if (i > 100) throw new Error('AI 创建超时')
      await sleep(100)
      job = await call('GET', `/assist/${job.id}`)
    }
    return job
  }
  const assist = (kind, text, extra = {}) =>
    call('POST', '/assist', {
      kind,
      targetId: '',
      cli: 'claude',
      model: '',
      messages: [{ role: 'user', text }],
      ...extra,
    }).then(assistDone)
  const draftAgent = {
    name: '审查员',
    description: '审查改动',
    cli: 'codex',
    model: 'gpt-5.6',
    icon: 'shield',
    // 启动时会装上内置项目工作流，用的 Agent 已经建出了「质量」分类；这里用一个肯定不会有的
    category: '自定义分类',
    instructions: '## 职责\n审查',
  }
  let job = await assist('agent', `要一个审查员\nFAKE_JSON:${JSON.stringify(draftAgent)}`)
  assert.equal(job.status, 'done', job.error)
  assert.equal(job.text, '这是按你的要求生成的配置。')
  assert.equal(job.proposal.agent.cli, 'codex')
  assert.equal(job.proposal.newCategory, '自定义分类', '不存在的分类标记为新建')
  c = calls().at(-1)
  assert.match(c.input, /配置助手[\s\S]*## 已有的 Agent[\s\S]*甲（claude[\s\S]*## 创建规则[\s\S]*## 输出格式/)
  // 权限按设置里的；Claude Code 的审批交给面板（弹出卡片），不再一律拒绝
  if (c.kind === 'claude') assert.ok(c.args.includes('--permission-prompt-tool'), '审批交给面板')
  assert.notEqual(c.cwd, projectDir, '不在项目目录里运行')
  // 第一次格式不对，自动让 CLI 修正
  job = await assist(
    'agent',
    `FAKE_JSON:${JSON.stringify({ ...draftAgent, cli: 'nope' })}\nFAKE_JSON2:${JSON.stringify(draftAgent)}`,
  )
  assert.equal(job.status, 'done', job.error)
  assert.equal(job.attempt, 2)
  assert.match(calls().at(-1).input, /不符合要求[\s\S]*nope/)
  // 两次都不对时失败并说明原因
  job = await assist('agent', `FAKE_JSON:${JSON.stringify({ ...draftAgent, name: '甲' })}`)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /两次都没有按格式输出[\s\S]*已经有叫「甲」/)
  // 优化已有 Agent：把当前配置给 CLI
  job = await assist('agent', `FAKE_JSON:${JSON.stringify({ ...draftAgent, name: '甲' })}`, { targetId: A.id })
  assert.equal(job.status, 'done', job.error)
  assert.match(calls().at(-1).input, /优化一个已有的Agent[\s\S]*## 当前的Agent[\s\S]*你是甲，负责规划/)
  // 工作流：引用已有 Agent 和新建的 Agent，校验阶段和节点
  const draftWf = {
    name: 'AI 流程',
    description: '',
    mainAgent: '甲',
    members: [{ agent: '乙', responsibility: '实现' }],
    newAgents: [draftAgent],
    flows: [
      {
        name: '主流程',
        main: true,
        nodes: [
          { key: 'a', title: '实现', agent: '乙', instructions: '写代码', review: '复核' },
          { key: 'b', title: '审查', agent: '审查员', instructions: '审查' },
          { key: 'c', title: '验收', agent: '', instructions: '' },
          { key: 'd', title: '跑小流程', flow: '小流程' },
        ],
        edges: [
          ['start', 'a'],
          ['start', 'b'],
          ['a', 'c'],
          ['b', 'c'],
          ['c', 'd'],
          ['d', 'end'],
        ],
      },
      {
        name: '复核',
        nodes: [{ key: 'r', title: '复核', agent: '甲' }],
        edges: [
          ['start', 'r'],
          ['r', 'end'],
        ],
      },
    ],
    document: '# 目标',
  }
  job = await assist('workflow', `FAKE_JSON:${JSON.stringify(draftWf)}`, { cli: 'codex' })
  assert.equal(job.status, 'done', job.error)
  const w = job.proposal.workflow
  assert.equal(w.mainAgentId, A.id)
  assert.equal(w.flows.length, 2)
  assert.equal(w.entryFlowId, w.flows[0].id)
  const mf = w.flows[0]
  assert.deepEqual(
    mf.nodes.map((n) => n.agentId),
    [B.id, 'new:审查员', '', ''],
  )
  assert.deepEqual(mf.nodes[0].hooks.review, { kind: 'sub', id: w.flows[1].id })
  assert.deepEqual(mf.nodes[3].flow, { kind: 'workflow', id: small.id })
  assert.equal(mf.edges.length, 6)
  assert.ok(mf.nodes[2].x > mf.nodes[0].x, '自动排列：下游节点在右边')
  assert.ok(
    w.members.some((m) => m.agentId === 'new:审查员'),
    '节点用到的 Agent 自动加入团队',
  )
  assert.equal(job.proposal.newAgents[0].ref, 'new:审查员')
  job = await assist('workflow', `FAKE_JSON:${JSON.stringify({ ...draftWf, mainAgent: '不存在' })}`)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /不存在/)
  const badFlow = {
    ...draftWf,
    flows: [
      {
        ...draftWf.flows[0],
        edges: [
          ['start', 'a'],
          ['a', 'c'],
          ['c', 'a'],
        ],
      },
    ],
  }
  job = await assist('workflow', `FAKE_JSON:${JSON.stringify(badFlow)}`)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /形成了环[\s\S]*没有从 start 连过来|没有从 start 连过来[\s\S]*形成了环|形成了环/)
  step('AI 创建：按格式生成、校验、自动修正一次，优化时带上当前配置，工作流解析 Agent 引用')

  // Skill 的 AI 创建 / 优化、MCP 工具的 AI 排查：同一套对话，当前内容由页面带来
  {
    const skillMd = '---\nname: demo-skill\ndescription: 做示例。在用户要示例时使用。\n---\n\n步骤\n'
    job = await assist('skill', `FAKE_JSON:${JSON.stringify({ name: 'demo-skill', content: skillMd })}`)
    assert.equal(job.status, 'done', job.error)
    assert.deepEqual(job.proposal, { kind: 'skill', name: 'demo-skill', content: skillMd })
    // front matter 里的 name 和文件夹名对不上：自动让 CLI 修正一次
    job = await assist(
      'skill',
      `FAKE_JSON:${JSON.stringify({ name: 'demo-skill', content: skillMd.replace('name: demo-skill', 'name: other') })} FAKE_JSON2:${JSON.stringify({ name: 'demo-skill', content: skillMd })}`,
    )
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.attempt, 2)
    // 优化：提示词带上当前的 SKILL.md，文件夹名不能被改
    const before = calls().length
    job = await assist('skill', `FAKE_JSON:${JSON.stringify({ name: 'renamed', content: skillMd })}`, {
      subject: { cli: 'claude', name: 'demo-skill', content: skillMd },
    })
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.proposal.name, 'demo-skill')
    assert.ok(calls().slice(before).at(-1).input.includes('文件夹名 demo-skill'))
    // MCP：提示词带上配置和测试连接的报错，名字不变
    const server = {
      name: 'mini',
      transport: 'stdio',
      command: 'npx',
      args: ['docs-mcp'],
      env: {},
      url: '',
      headers: {},
    }
    const fixed = { ...server, args: ['-y', 'docs-mcp'] }
    job = await assist('mcp', `FAKE_JSON:${JSON.stringify({ ...fixed, name: 'x' })}`, {
      subject: { name: 'mini', server: JSON.stringify(server), error: 'spawn npx ENOENT', clis: 'Claude Code' },
    })
    assert.equal(job.status, 'done', job.error)
    assert.deepEqual(job.proposal, { kind: 'mcp', server: fixed })
    const prompt = calls().at(-1).input
    assert.ok(prompt.includes('spawn npx ENOENT') && prompt.includes('docs-mcp'))
    job = await assist('mcp', `FAKE_JSON:${JSON.stringify({ transport: 'http', url: 'ftp://x' })}`, {
      subject: { name: 'mini', server: '{}' },
    })
    assert.equal(job.status, 'failed')
  }
  step('Skill 的 AI 创建 / 优化、MCP 工具的 AI 排查：校验格式、自动修正、文件夹名和工具名不被改')

  // ---- UI 设计 ----
  {
    await call('PUT', '/settings', {
      ...settings,
      defaultCli: 'codex',
      imageGen: { cli: 'codex', model: '', effort: '' },
    })
    // UI 设计用自己的项目，和 Agent 的项目分开
    await assert.rejects(
      call('POST', '/designs', { projectId: project.id, kind: 'game', title: 'X' }),
      /项目不存在/,
      'Agent 的项目不能放设计',
    )
    const uiProject = await call('POST', '/designs/projects', { name: 'Game', path: projectDir })
    assert.deepEqual(
      (await call('GET', '/designs/projects')).map((p) => p.name),
      ['Game'],
    )
    // 项目提示词：只改名字时不会清掉提示词；AI 生成、翻译
    await call('PUT', `/designs/projects/${uiProject.id}`, {
      prompts: [
        { id: 'p1', category: 'style', zh: '暗黑奇幻', en: 'grim castle style', enabled: true },
        { id: 'p2', category: 'avoid', zh: '不要文字', en: 'no text', enabled: true },
        { id: 'p3', category: 'color', zh: '大红色', en: 'bright red', enabled: false },
      ],
    })
    await call('PUT', `/designs/projects/${uiProject.id}`, { name: 'Game' })
    assert.equal((await call('GET', '/designs/projects'))[0].prompts.length, 3, '改名不影响提示词')
    const gen = await call('POST', '/designs/prompts/ai', { mode: 'generate', text: '蒸汽朋克风' })
    assert.deepEqual(
      gen.prompts.map((p) => [p.category, p.zh, p.en]),
      [
        ['style', '蒸汽朋克', 'steampunk'],
        ['material', '黄铜齿轮', 'brass gears'],
      ],
    )
    const tr = await call('POST', '/designs/prompts/ai', {
      mode: 'translate',
      items: [{ category: 'light', zh: '柔和顶光' }],
    })
    assert.deepEqual(tr.prompts[0], { category: 'light', zh: '柔和顶光', en: 'EN:柔和顶光' })
    await assert.rejects(call('POST', '/designs/prompts/ai', { mode: 'generate', text: '' }), /没有要处理的内容/)
    step('UI 项目提示词：按分类保存，AI 生成和翻译')

    // 风格库：增删改；没定风格的设计，AI 的提示词里带上同类风格作为选项
    const st = await call('POST', '/designs/styles', {
      name: '暗黑奇幻',
      kind: 'game',
      summary: '石刻金边',
      en: 'dark fantasy STYLELIB',
      prompts: [{ category: 'style', zh: '暗黑奇幻', en: 'dark fantasy' }],
    })
    assert.equal(
      (await call('PUT', `/designs/styles/${st.id}`, { name: '暗黑奇幻·改' })).summary,
      '石刻金边',
      '只改传了的',
    )
    assert.equal((await call('GET', '/designs/styles')).find((x) => x.id === st.id).name, '暗黑奇幻·改')
    await call('DELETE', `/designs/styles/${st.id}`)
    assert.ok(!(await call('GET', '/designs/styles')).some((x) => x.id === st.id))
    // 内置风格：游戏和网页各一批，排在自己存的后面；只读，不能改也不能删
    const all = await call('GET', '/designs/styles')
    const builtin = all.filter((x) => x.builtin)
    assert.ok(
      builtin.filter((x) => x.kind === 'game').length >= 10 && builtin.filter((x) => x.kind === 'web').length >= 10,
    )
    assert.ok(all.findIndex((x) => x.builtin) > all.findLastIndex((x) => !x.builtin), '自己存的在前，内置的在后')
    await assert.rejects(call('PUT', `/designs/styles/${builtin[0].id}`, { name: '改' }), /内置风格不能修改/)
    await assert.rejects(call('DELETE', `/designs/styles/${builtin[0].id}`), /内置风格不能删除/)
    step('风格库：存、改、删；内置风格只读')
    const design = await call('POST', '/designs', {
      projectId: uiProject.id,
      kind: 'game',
      title: 'Main Menu',
      designSize: { X: 1920, Y: 1080 },
    })
    assert.equal(design.root.Type, 'CanvasPanel')
    assert.ok((await call('GET', '/designs')).some((d) => d.id === design.id))
    const tasksBefore = (await call('GET', '/tasks')).length
    const waitJob = async (id) => {
      for (let i = 0; ; i++) {
        const d = await call('GET', `/designs/${id}`)
        if (d.job?.status !== 'running') return d
        if (i > 200) throw new Error('设计任务超时')
        await sleep(100)
      }
    }
    const tree = {
      reply: '主菜单搭好了',
      style: 'dark fantasy',
      root: {
        Type: 'CanvasPanel',
        Name: 'Root',
        Children: [
          {
            Type: 'Image',
            Name: 'Bg',
            Slot: { LayoutData: { Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } } } },
            Properties: { Brush: { ResourceObject: 'img:bg', DrawAs: 'Image' } },
          },
          {
            Type: 'VerticalBox',
            Name: 'Buttons',
            Children: [
              { Type: 'UserWidget', Name: 'StartBtn', Class: 'WBP_MenuButton' },
              { Type: 'UserWidget', Name: 'QuitBtn', Class: 'WBP_MenuButton' },
            ],
          },
        ],
      },
      components: [
        {
          Name: 'WBP_MenuButton',
          DesignSize: { X: 320, Y: 72 },
          Root: {
            Type: 'Button',
            Name: 'Btn',
            Properties: { WidgetStyle: { Normal: { ResourceObject: 'img:frame', DrawAs: 'Box' } } },
            Children: [
              { Type: 'TextBlock', Name: 'Label', Properties: { Text: 'Start', ColorAndOpacity: '#FFD080FF' } },
            ],
          },
        },
      ],
      images: [
        { id: 'bg', name: 'MenuBg', prompt: 'castle at night', width: 1920, height: 1080, transparent: false },
        {
          id: 'frame',
          name: 'BtnFrame',
          prompt: 'golden frame',
          width: 320,
          height: 72,
          nineSlice: { Left: 0.2, Top: 0.3, Right: 0.2, Bottom: 0.3 },
        },
      ],
    }
    // 第一次输出写错了控件类型，自动修正一次
    const wrong = { ...tree, root: { ...tree.root, Children: [{ Type: 'Fancy', Name: 'X' }] } }
    await call('POST', `/designs/${design.id}/chat`, {
      text: `做主菜单 FAKE_DESIGN:${JSON.stringify(wrong)}\nFAKE_DESIGN2:${JSON.stringify(tree)}`,
      source: { kind: 'cli' },
      count: 2,
    })
    let d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job))
    assert.equal(d.rev, 1)
    assert.equal(d.style, 'dark fantasy')
    assert.deepEqual(
      d.root.Children.map((w) => [w.Type, w.Name, !!w.Slot?.LayoutData]),
      [
        ['Image', 'Bg', true],
        ['VerticalBox', 'Buttons', true],
      ],
      '按父控件补上插槽',
    )
    assert.deepEqual(d.root.Children[0].Slot.LayoutData.Anchors.Maximum, { X: 1, Y: 1 }, 'AI 写的值盖过默认值')
    assert.equal(d.root.Children[1].Children[0].Slot.Size.SizeRule, 'Automatic')
    assert.equal(d.components[0].Root.Children[0].Slot.HorizontalAlignment, 'HAlign_Center')
    assert.deepEqual(
      d.images.map((i) => [i.id, i.status, i.variants.length, i.variants[0]?.source, i.variants[0]?.width]),
      [
        ['bg', 'idle', 2, 'cli', 1920],
        ['frame', 'idle', 2, 'cli', 320],
      ],
      '每张图生成两版：一版从 savedPath 读，一版从 base64 读；存下来的都是设计里要的精确宽度',
    )
    const agentMsg = d.messages.at(-1)
    assert.equal(agentMsg.role, 'agent')
    assert.equal(agentMsg.text, '主菜单搭好了')
    assert.deepEqual(agentMsg.images, ['bg', 'frame'])
    assert.equal(agentMsg.run.cli, 'codex')
    const prompts = calls().filter((c) => c.kind === 'codex' && /image_gen/.test(c.stdin ?? c.input ?? ''))
    assert.ok(prompts.length >= 2, '生图交给 Codex 的 image_gen')
    const imgInput = prompts.at(-1).stdin ?? prompts.at(-1).input
    assert.match(imgInput, /Art style: grim castle style/, '生图带上项目提示词的英文')
    assert.match(imgInput, /Avoid: no text/)
    assert.doesNotMatch(imgInput, /bright red/, '停用的提示词不带')
    assert.match(imgInput, /Additional style for this screen: dark fantasy/)
    const designInput = calls()
      .filter((c) => /你是游戏 UI 设计助手/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(designInput.stdin ?? designInput.input, /暗黑奇幻（grim castle style）/, '设计 AI 看得到项目提示词')
    assert.deepEqual(
      d.job.images.map((i) => [i.id, i.status, i.got, i.want]),
      [
        ['bg', 'done', 2, 2],
        ['frame', 'done', 2, 2],
      ],
      '每张图的生成进度',
    )
    assert.equal(d.job.run.cli, 'codex')
    assert.equal((await call('GET', '/tasks')).length, tasksBefore, '设计不出现在任务列表里')

    // 图片文件能取到；生成失败把错误显示在图片上
    const file = await fetch(`${base}/designs/${design.id}/files/${d.images[0].variants[0].file}`)
    assert.equal(file.headers.get('content-type'), 'image/png')
    await call('POST', `/designs/${design.id}/images/bg/generate`, {
      source: { kind: 'cli' },
      count: 1,
      prompt: 'IMGFAIL castle',
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'failed')
    assert.equal(d.images[0].status, 'failed')
    assert.match(d.images[0].error, /内容不符合政策/)
    assert.equal(d.images[0].variants.length, 2, '失败不影响已有的版本')

    // 页面保存：改选中的版本和名字，生成结果以服务端为准
    const doc = { title: d.title, designSize: d.designSize, style: d.style, root: d.root, components: d.components }
    d = await call('PUT', `/designs/${design.id}`, {
      ...doc,
      images: d.images.map((i) => (i.id === 'frame' ? { ...i, selected: 1, name: 'ButtonFrame', variants: [] } : i)),
    })
    const frame = d.images.find((i) => i.id === 'frame')
    assert.deepEqual([frame.name, frame.selected, frame.variants.length], ['ButtonFrame', 1, 2])

    // 导出：单个 JSON 内嵌贴图；ZIP 带 JSON 和贴图文件；导出到项目目录
    const json = await (await fetch(`${base}/designs/${design.id}/export?format=json`)).json()
    assert.equal(json.Format, 'AgentPanel.UMG')
    assert.equal(json.Name, 'WBP_MainMenu')
    assert.deepEqual(
      json.Textures.map((x) => [x.Name, x.File, !!x.Data]),
      [
        ['T_MenuBg', 'Textures/T_MenuBg.png', true],
        ['T_ButtonFrame', 'Textures/T_ButtonFrame.png', true],
      ],
    )
    assert.deepEqual(json.Textures[1].NineSlice, { Left: 0.2, Top: 0.3, Right: 0.2, Bottom: 0.3 })
    assert.equal(json.Root.Children[0].Properties.Brush.ResourceObject, 'T_MenuBg')
    assert.equal(json.UserWidgets[0].Name, 'WBP_MenuButton')
    const label = json.UserWidgets[0].Root.Children[0]
    assert.equal(label.Slot.Type, 'ButtonSlot')
    assert.equal(label.Properties.ColorAndOpacity.Hex, '#FFD080FF')
    const zipRes = await fetch(`${base}/designs/${design.id}/export`)
    assert.equal(zipRes.headers.get('content-type'), 'application/zip')
    const zip = Buffer.from(await zipRes.arrayBuffer())
    assert.equal(zip.readUInt32LE(0), 0x04034b50)
    for (const n of ['WBP_MainMenu.umg.json', 'Textures/T_MenuBg.png', 'Textures/T_ButtonFrame.png'])
      assert.ok(zip.includes(Buffer.from(n)), `ZIP 里有 ${n}`)
    const { dir } = await call('POST', `/designs/${design.id}/export-to-project`)
    assert.ok(existsSync(path.join(dir, 'WBP_MainMenu.umg.json')))
    assert.ok(existsSync(path.join(dir, 'Textures/T_ButtonFrame.png')))
    rmSync(path.join(projectDir, 'UI'), { recursive: true, force: true })
    // 标注随消息发给 AI：编号、意思、范围、涉及的控件和说明
    await call('POST', `/designs/${design.id}/chat`, {
      text: '按标注改 FAKE_DESIGN:{"reply":"改好了"}',
      source: { kind: 'none' },
      annotations: [
        {
          id: 'a1',
          kind: 'change',
          shape: 'rect',
          points: [10, 20, 300, 100],
          note: '按钮换成金色',
          target: '',
          widgets: ['Buttons'],
        },
      ],
    })
    d = await waitJob(design.id)
    const asked = calls()
      .filter((c) => c.kind === 'codex' && c.input?.startsWith('你是游戏 UI 设计助手'))
      .at(-1).input
    assert.match(
      asked,
      /用户在效果图上的标注[\s\S]*1\.【修改】框选，范围 x=10 y=20 宽=300 高=100\n {3}涉及的控件：Buttons\n {3}说明：按钮换成金色/,
    )
    assert.equal(d.messages.at(-2).annotations[0].note, '按钮换成金色')
    assert.equal(d.messages.at(-1).text, '改好了')
    // AI 一步步改（ops）：改属性、加控件、改名、改子控件里的；写错的操作退回去让它改
    const revBefore = d.rev
    const badOps = { reply: 'x', ops: [{ op: 'set', target: 'Nope', path: 'Properties.Text', value: 'a' }] }
    const goodOps = {
      reply: '改了几处',
      ops: [
        { op: 'rename', target: 'Bg', name: 'Img_Bg' },
        {
          op: 'add',
          parent: 'Buttons',
          widget: { Type: 'TextBlock', Name: 'Txt_Ver', Properties: { Text: 'v1.0.3' } },
        },
        { op: 'set', in: 'WBP_MenuButton', target: 'Label', path: 'Properties.Text', value: '开始游戏' },
        { op: 'set', target: 'Buttons', path: 'Slot.LayoutData.Offsets', value: { Top: 500 } },
      ],
    }
    await call('POST', `/designs/${design.id}/chat`, {
      text: `改一下 FAKE_DESIGN:${JSON.stringify(badOps)}\nFAKE_DESIGN2:${JSON.stringify(goodOps)}`,
      source: { kind: 'none' },
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    assert.equal(d.rev, revBefore + 1)
    assert.deepEqual(
      d.root.Children.map((w) => w.Name),
      ['Img_Bg', 'Buttons'],
    )
    const ver = d.root.Children[1].Children.at(-1)
    assert.deepEqual([ver.Name, ver.Properties.Text, ver.Slot.Size.SizeRule], ['Txt_Ver', 'v1.0.3', 'Automatic'])
    assert.equal(d.components[0].Root.Children[0].Properties.Text, '开始游戏')
    assert.equal(d.root.Children[1].Slot.LayoutData.Offsets.Top, 500, '只改写到的字段')
    assert.ok(d.root.Children[1].Slot.LayoutData.Offsets.Right > 0, '没写到的字段保留')
    // 写错的操作当场把错误交还给 AI，它接着改；过程按顺序存在回复里
    const failedTool = d.messages
      .at(-1)
      .parts.flatMap((p) => p.tools)
      .find((x) => x.failed)
    assert.match(failedTool.output, /主界面里没有叫 Nope 的控件/)
    // 用设计工具（MCP）改：CLI 调加控件、改属性、改名、建子控件等工具，回复只写普通文字
    // 每个工具一次提交多条；控件写法宽松（属性直接写在控件上、插槽用简写），旧的单数工具名也认
    const mcpCalls = [
      ['rename_widget', { name: 'Txt_Ver', to: 'Txt_Version' }],
      ['update_widgets', { items: [{ name: 'Txt_Version', properties: { Text: 'v2.0.0' } }] }],
      [
        'add_widgets',
        {
          items: [
            { parent: 'Buttons', widget: { type: 'TextBlock', name: 'Txt_Tip', Text: '提示', slot: { padding: 8 } } },
            {
              parent: 'Root',
              widget: {
                Type: 'TextBlock',
                Name: 'Txt_Corner',
                Text: 'v',
                Slot: { anchor: 'bottom-right', x: -24, y: -16, w: 120, h: 30 },
              },
            },
          ],
        },
      ],
      [
        'create_components',
        { items: [{ name: 'WBP_Tag', size: { X: 64, Y: 32 }, root: { Type: 'Overlay', Name: 'Root' } }] },
      ],
      ['set_design', { style: 'clean' }],
    ]
    await call('POST', `/designs/${design.id}/chat`, {
      text: `用工具改 FAKE_MCP:${JSON.stringify(mcpCalls)}`,
      source: { kind: 'none' },
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    assert.match(d.messages.at(-1).text, /^工具改好了/, '回复是普通文字，不要求 JSON')
    const box = d.root.Children[1].Children
    assert.deepEqual(
      [box.at(-2).Name, box.at(-2).Properties.Text, box.at(-1).Name],
      ['Txt_Version', 'v2.0.0', 'Txt_Tip'],
      '工具里的改动存下来了',
    )
    assert.deepEqual(box.at(-1).Slot.Padding, { Left: 8, Top: 8, Right: 8, Bottom: 8 }, '插槽的简写')
    const corner = d.root.Children.find((w) => w.Name === 'Txt_Corner').Slot.LayoutData
    assert.deepEqual(
      [corner.Anchors.Minimum, corner.Alignment, corner.Offsets],
      [
        { X: 1, Y: 1 },
        { X: 1, Y: 1 },
        { Left: -24, Top: -16, Right: 120, Bottom: 30 },
      ],
      '画布位置的简写换成锚点和偏移',
    )
    assert.ok(d.components.some((c) => c.Name === 'WBP_Tag' && c.DesignSize.X === 64))
    assert.equal(d.style, 'clean')
    // 先出原画：开关打开时 AI 不能搭界面，只出整屏原画；原画按设计稿尺寸存成候选，确认模板后照着模板做、出切图
    const sketch = await call('POST', '/designs', { projectId: uiProject.id, kind: 'game', title: 'Bag' })
    await call('POST', `/designs/${sketch.id}/chat`, {
      text: `做背包 FAKE_MCP:${JSON.stringify([
        ['add_widgets', { items: [{ parent: 'RootCanvas', widget: { Type: 'TextBlock', Name: 'T', Text: 'x' } }] }],
        ['generate_concepts', { prompt: 'dark fantasy inventory screen', negative: 'cartoon', count: 4 }],
      ])}`,
      source: { kind: 'cli' },
      count: 2,
      concept: true,
    })
    d = await waitJob(sketch.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    assert.match(d.messages.at(-1).text, /先出原画/, '先出原画阶段搭界面的工具被退回')
    assert.equal(d.root.Children?.length ?? 0, 0, '没有搭界面')
    assert.deepEqual(
      d.concept.images.map((i) => [i.round, i.width, i.height, i.prompt, i.negative]),
      [
        [1, 1920, 1080, 'dark fantasy inventory screen', 'cartoon'],
        [1, 1920, 1080, 'dark fantasy inventory screen', 'cartoon'],
      ],
      '按输入框选的张数出两张候选（AI 写的 count 不算），按设计稿尺寸存下',
    )
    assert.equal(d.concept.selected, d.concept.images[0].id)
    const conceptGen = calls()
      .filter((c) => /Game UI concept art/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(conceptGen.stdin ?? conceptGen.input, /Negative prompt \(none of these may appear\):.*cartoon/)
    const tpl = d.concept.images[1].id
    d = await call('POST', `/designs/${sketch.id}/concept`, { action: 'approve', id: tpl })
    assert.equal(d.concept.approved, tpl)
    await call('POST', `/designs/${sketch.id}/chat`, {
      text: `照着模板做 FAKE_MCP:${JSON.stringify([
        [
          'add_images',
          { images: [{ id: 'gem', name: 'Gem', prompt: 'a red gem', negative: 'frame', width: 64, height: 64 }] },
        ],
        [
          'add_widgets',
          {
            items: [
              {
                parent: 'RootCanvas',
                widget: { Type: 'Image', Name: 'Img_Gem', Brush: { ResourceObject: 'img:gem' } },
              },
            ],
          },
        ],
      ])}`,
      source: { kind: 'cli' },
      concept: true,
    })
    d = await waitJob(sketch.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    const tplInput = calls()
      .filter((c) => /你是游戏 UI 设计助手/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(tplInput.stdin ?? tplInput.input, new RegExp(`已确认的效果图模板[\\s\\S]*concept:${tpl}`))
    assert.equal(d.images.find((i) => i.id === 'gem').negative, 'frame')
    const gemGen = calls()
      .filter((c) => /a red gem/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(gemGen.stdin ?? gemGen.input, /approved concept art/, '切图带着模板作为参考')
    assert.match(gemGen.stdin ?? gemGen.input, /Negative prompt.*frame/)
    d = await call('POST', `/designs/${sketch.id}/concept`, { action: 'remove', id: tpl })
    assert.deepEqual([d.concept.images.length, d.concept.approved], [1, ''], '删掉模板就回到挑图')
    step('先出原画：不能先搭界面，出候选、确认模板后照着模板出切图')
    // 没在改设计时补充不了：告诉页面改成排队
    assert.deepEqual(await call('POST', `/designs/${design.id}/steer`, { text: '再大一点' }), { steered: false })
    // 看图量尺寸：inspect_image 量尺寸和颜色，view_image 画坐标格、放大一块，存成文件给 AI 读图
    const pngOf = (w, h, pix) => {
      const raw = Buffer.alloc((w * 3 + 1) * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pix(x, y), y * (w * 3 + 1) + 1 + x * 3)
      const chunk = (type, body) => {
        const head = Buffer.alloc(8)
        head.writeUInt32BE(body.length, 0)
        head.write(type, 4, 'ascii')
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
        return Buffer.concat([head, body, crc])
      }
      const ihdr = Buffer.alloc(13)
      ihdr.writeUInt32BE(w, 0)
      ihdr.writeUInt32BE(h, 4)
      ihdr[8] = 8
      ihdr[9] = 2
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ])
    }
    const ref = await call('POST', '/uploads', {
      name: '参考图.png',
      mime: 'image/png',
      data: pngOf(100, 60, (x) => (x < 50 ? [255, 0, 0] : [0, 0, 255])).toString('base64'),
    })
    await call('POST', `/designs/${design.id}/chat`, {
      text: `量一下参考图 FAKE_MCP:${JSON.stringify([
        [
          'inspect_image',
          {
            source: 'attachment:1',
            points: [
              { x: 10, y: 10 },
              { x: 90, y: 10 },
            ],
          },
        ],
        ['view_image', { source: 'attachment:1', region: { x: 0, y: 0, w: 50, h: 30 } }],
        ['inspect_image', { source: 'attachment:9' }],
      ])}`,
      source: { kind: 'none' },
      attachments: [ref],
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    const looked = d.messages.at(-1).text
    assert.match(looked, /"size":"100×60"/, '量出精确尺寸')
    assert.match(looked, /"color":"#FF0000"[\s\S]*"color":"#0000FF"/, '取到指定位置的颜色')
    assert.match(looked, /views[\\/]view-1\.png/, '放大的图存成文件交给 AI 读')
    assert.match(looked, /没有这个附件/, '附件序号不对时说明原因')
    assert.match(
      calls()
        .filter((c) => c.kind === 'codex' && c.input?.startsWith('你是游戏 UI 设计助手'))
        .at(-1).input,
      /附件 1「参考图\.png」：100×60 像素/,
      '附件的精确尺寸写进了要求',
    )

    // 图标表：同一个 sheet 的图标一次生成再切开，每个都是各自精确的尺寸；漏画的单独补
    const callsBefore = calls().length
    const icon = (id, n, extra = '') => ({
      id,
      name: `Ico_${n}`,
      prompt: `${extra}item ${n}`,
      width: 48,
      height: 48,
      sheet: 'items',
    })
    const icons = [icon('ico_a', 'A'), icon('ico_b', 'B'), icon('ico_c', 'C', 'MISS3 ')]
    await call('POST', `/designs/${design.id}/chat`, {
      text: `做三个物品图标 FAKE_MCP:${JSON.stringify([
        ['add_images', { images: icons }],
        [
          'add_widgets',
          {
            items: icons.map((x, i) => ({
              parent: 'Root',
              widget: {
                Type: 'Image',
                Name: x.name,
                Brush: { ResourceObject: `img:${x.id}` },
                Slot: { anchor: 'top-left', x: 10 + i * 60, y: 10, w: 48, h: 48 },
              },
            })),
          },
        ],
      ])}`,
      source: { kind: 'cli' },
      count: 1,
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    const pngSize = async (file) => {
      const b = Buffer.from(await (await fetch(`${base}/designs/${design.id}/files/${file}`)).arrayBuffer())
      return [b.readUInt32BE(16), b.readUInt32BE(20)]
    }
    for (const id of ['ico_a', 'ico_b', 'ico_c']) {
      const im = d.images.find((x) => x.id === id)
      assert.equal(im.variants.length, 1, `${id} 有图`)
      assert.deepEqual(await pngSize(im.variants[0].file), [48, 48], `${id} 是要求的精确尺寸`)
    }
    const sheetGen = calls()
      .slice(callsBefore)
      .filter((c) => c.kind === 'codex' && (c.stdin ?? c.input ?? '').startsWith('请用内置的 image_gen'))
    assert.equal(sheetGen.length, 2, '三个图标一次出图，漏画的第三个单独补一张')
    assert.match(
      sheetGen[0].stdin ?? sheetGen[0].input,
      /3 separate, individual icons of the same size, laid out one after another in a strict, evenly spaced grid of 2 columns × 2 rows/,
    )
    assert.match(sheetGen[0].stdin ?? sheetGen[0].input, /1\. item A\n2\. item B\n3\. MISS3 item C/)
    assert.doesNotMatch(sheetGen[1].stdin ?? sheetGen[1].input, /sprite sheet/)

    const mcpAsk = calls()
      .filter((c) => c.kind === 'codex' && c.input?.startsWith('你是游戏 UI 设计助手'))
      .at(-1)
    assert.match(mcpAsk.input, /用 design 工具改设计/, '有工具时提示词让 AI 优先用工具')
    assert.ok(
      (mcpAsk.args ?? []).some((x) => /^mcp_servers\.design\.url=/.test(x)),
      '把工具地址传给 Codex',
    )
    step(
      'UI 设计：AI 搭控件树（自动修正一次）、一步步改（ops 和设计工具）、Codex 生图、保存、导出成 UMG 的 JSON 和贴图，和任务分开',
    )

    // 浏览器扩展：只认 Gemini 和 ChatGPT 的标签页，只有扩展能调 /bridge
    const ext = { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop' }
    const bridge = (method, url, body, headers = ext) =>
      fetch(`${base}/bridge${url}`, { method, headers, body: body && JSON.stringify(body) })
    assert.equal(
      (
        await bridge(
          'POST',
          '/hello',
          { tabs: [] },
          { 'content-type': 'application/json', origin: 'https://evil.example' },
        )
      ).status,
      403,
      '网站不能冒充扩展',
    )
    assert.equal(
      (
        await call('POST', `/designs/${design.id}/images/bg/generate`, {
          source: { kind: 'browser', tabId: '7' },
          count: 1,
        })
      ).job.status,
      'running',
    )
    d = await waitJob(design.id)
    assert.match(d.images[0].error, /扩展没有连上/)
    const hello = await bridge('POST', '/hello', {
      version: '1.3.0',
      tabs: [
        { id: 7, url: 'https://gemini.google.com/app/abc', title: 'Gemini' },
        { id: 8, url: 'https://chatgpt.com/c/1', title: 'ChatGPT' },
        { id: 9, url: 'https://www.google.com/', title: 'Google' },
      ],
    })
    // 扩展靠这个版本号判断要不要自己重新加载
    assert.equal(typeof (await hello.json()).latestVersion, 'string')
    // 一键刷新扩展：1.3 起的扩展在下次报到时收到一次重新加载的要求
    assert.deepEqual(await call('POST', '/designs/browser/reload', {}), { auto: true })
    const helloAgain = () =>
      bridge('POST', '/hello', {
        version: '1.3.0',
        tabs: [
          { id: 7, url: 'https://gemini.google.com/app/abc' },
          { id: 8, url: 'https://chatgpt.com/c/1' },
        ],
      }).then((r) => r.json())
    assert.equal((await helloAgain()).reload, true)
    assert.equal((await helloAgain()).reload, false, '刷新要求只带一次')
    const status = await call('GET', '/designs/browser')
    assert.equal(status.connected, true)
    assert.equal(typeof status.latestVersion, 'string')
    assert.ok(Array.isArray(status.browsers))
    // 测试的程序目录里没有扩展（打包时才会把扩展写进 server.mjs）
    await assert.rejects(call('POST', '/designs/browser/install', { browser: 'nope' }), /没有找到/)
    assert.deepEqual(
      status.tabs.map((x) => [x.id, x.site]),
      [
        ['7', 'gemini'],
        ['8', 'chatgpt'],
      ],
    )
    await call('POST', `/designs/${design.id}/images/frame/generate`, {
      source: { kind: 'browser', tabId: '7' },
      count: 2,
    })
    const cmd = (await (await bridge('GET', '/poll')).json()).cmd
    assert.deepEqual([cmd.type, cmd.tabId, cmd.count, cmd.chroma, cmd.newChat], ['generate', '7', 2, true, true])
    assert.match(cmd.prompt, /#00FF00/, '透明图让网页画纯绿底，扩展再抠掉')
    await bridge('POST', '/progress', { id: cmd.id, text: '等待生成' })
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
    // 新版扩展取到一张就先交一张：还在生成时设计里已经有这一版
    await bridge('POST', '/image', { id: cmd.id, data: png })
    for (let i = 0; i < 50; i++) {
      const cur = await call('GET', `/designs/${design.id}`)
      if (cur.images.find((x) => x.id === 'frame').variants.length === 3) break
      await sleep(50)
    }
    const mid = await call('GET', `/designs/${design.id}`)
    assert.equal(mid.job.status, 'running')
    assert.equal(mid.images.find((x) => x.id === 'frame').variants.length, 3, '先交的一张马上放进设计')
    assert.equal(mid.images.find((x) => x.id === 'frame').selected, 2, '第一张到了就选中')
    assert.equal(mid.job.images[0].text, '等待生成')
    await bridge('POST', '/result', { id: cmd.id, ok: true, images: [{ data: png }], streamed: 1 })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done')
    const f2 = d.images.find((i) => i.id === 'frame')
    assert.deepEqual(
      f2.variants.map((v) => v.source),
      ['cli', 'cli', 'browser', 'browser'],
    )
    assert.equal(f2.selected, 2, '新生成的一版自动选中')
    await call('POST', `/designs/${design.id}/images/frame/generate`, {
      source: { kind: 'browser', tabId: '8' },
      count: 1,
    })
    const cmd2 = (await (await bridge('GET', '/poll')).json()).cmd
    await bridge('POST', '/result', { id: cmd2.id, ok: false, error: '没有找到输入框' })
    d = await waitJob(design.id)
    assert.match(d.images.find((i) => i.id === 'frame').error, /没有找到输入框/)
    // 失败的图点重试：没有在生成时单独生成这一张，成功后错误清掉
    assert.equal(d.job.images[0].status, 'failed')
    const retried = await call('POST', `/designs/${design.id}/images/frame/retry`, {
      source: { kind: 'browser', tabId: '8' },
      count: 1,
    })
    assert.equal(retried.job.status, 'running')
    const cmd3 = (await (await bridge('GET', '/poll')).json()).cmd
    assert.equal(cmd3.tabId, '8')
    await bridge('POST', '/image', { id: cmd3.id, data: png })
    await bridge('POST', '/result', { id: cmd3.id, ok: true, images: [], streamed: 1 })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done')
    assert.equal(d.images.find((i) => i.id === 'frame').status, 'idle')
    assert.equal(d.images.find((i) => i.id === 'frame').variants.length, 5)
    step('浏览器扩展：只列出 Gemini、ChatGPT 标签页，取指令、交回图片，错误显示在图片上、能重试；网站不能调用')

    await assert.rejects(
      call('POST', `/designs/${design.id}/images/generate`, {
        ids: ['nope'],
        source: { kind: 'browser', tabId: '8' },
        count: 1,
      }),
      /没有要生成的图片/,
    )
    // 网页 UI：根控件是占满整页的 Frame，AI 用 Frame / Text / WebButton 搭，导出成 HTML
    const webD = await call('POST', '/designs', {
      projectId: uiProject.id,
      kind: 'web',
      title: 'Landing Page',
      designSize: { X: 1440, Y: 900 },
    })
    assert.deepEqual([webD.kind, webD.root.Type, webD.root.Properties.Width], ['web', 'Frame', 'fill'])
    const webTree = {
      reply: '首页好了',
      ops: [
        {
          op: 'add',
          parent: 'Page',
          widget: { Type: 'Text', Name: 'Title', Properties: { Text: '欢迎来到 Flowboard', Tag: 'h1' } },
        },
        {
          op: 'add',
          parent: 'Page',
          widget: {
            Type: 'Frame',
            Name: 'Actions',
            Properties: { Direction: 'row', Gap: 12, Mobile: { Direction: 'column' } },
            Children: [
              {
                Type: 'WebButton',
                Name: 'Btn_Go',
                Properties: { Text: '开始使用', Href: '/start', Hover: { Background: '#1D4ED8FF' } },
              },
              {
                Type: 'Text',
                Name: 'Badge',
                Slot: { Position: 'absolute', Pin: 'top-right', X: 4, Y: 4 },
                Properties: { Text: 'NEW' },
              },
            ],
          },
        },
      ],
    }
    await call('POST', `/designs/${webD.id}/chat`, {
      text: `做首页 FAKE_DESIGN:${JSON.stringify(webTree)}`,
      source: { kind: 'none' },
    })
    let wd = await waitJob(webD.id)
    assert.equal(wd.job.status, 'done', JSON.stringify(wd.job.error))
    assert.deepEqual(
      wd.root.Children.map((w) => [w.Type, w.Name, w.Slot?.AlignSelf]),
      [
        ['Text', 'Title', 'auto'],
        ['Frame', 'Actions', 'auto'],
      ],
    )
    const webAsk = calls()
      .filter((c) => c.kind === 'codex' && /你是网页 UI 设计助手/.test(c.input ?? ''))
      .at(-1)
    assert.ok(webAsk, '网页设计用网页的提示词')
    assert.doesNotMatch(webAsk.input, /CanvasPanelSlot/, '网页的提示词里没有 UMG 的插槽')
    const html = await (await fetch(`${base}/designs/${webD.id}/export?format=json`)).text()
    assert.match(html, /<h1 class="Title">欢迎来到 Flowboard<\/h1>/)
    assert.match(html, /\.Actions \{[^}]*flex-direction: row;[^}]*gap: 12px;/)
    assert.match(html, /<a class="Btn_Go" href="\/start">开始使用<\/a>/, '写了 Href 就是链接')
    assert.match(html, /\.Btn_Go:hover \{ background-color: rgba\(29,78,216,1\); \}/, '悬停样式')
    assert.match(html, /@media \(max-width: 767px\) \{\n {2}\.Actions \{ flex-direction: column; \}/, '手机上改竖排')
    assert.match(html, /\.Badge \{[^}]*position: absolute;[^}]*top: 4px;[^}]*right: 4px;/, '绝对定位贴在右上角')
    const reactZip = Buffer.from(await (await fetch(`${base}/designs/${webD.id}/export?format=react`)).arrayBuffer())
    assert.ok(reactZip.includes(Buffer.from('LandingPage.tsx')), JSON.stringify(reactZip.subarray(30, 80).toString()))
    assert.ok(reactZip.includes(Buffer.from('max-md:flex-col')), 'React 组件里手机用 max-md:')
    const webZip = Buffer.from(await (await fetch(`${base}/designs/${webD.id}/export?format=zip`)).arrayBuffer())
    assert.ok(webZip.includes(Buffer.from('index.html')))
    // 版本：AI 改之前自动存了一个；手动存一个；恢复到 AI 改之前，恢复前的样子也存下来
    let vers = await call('GET', `/designs/${webD.id}/versions`)
    assert.equal(vers.length, 1)
    assert.ok(vers[0].auto && /AI 修改前/.test(vers[0].name))
    const named = await call('POST', `/designs/${webD.id}/versions`, { name: '第一稿' })
    assert.equal(named.auto, false)
    const full = await call('GET', `/designs/${webD.id}/versions/${named.id}`)
    assert.equal(full.snapshot.root.Children.length, 2, '版本里有完整的控件树')
    const restored = await call('POST', `/designs/${webD.id}/versions/${vers[0].id}/restore`)
    assert.equal(restored.root.Children.length, 0, '恢复到 AI 改之前（空页面）')
    vers = await call('GET', `/designs/${webD.id}/versions`)
    assert.deepEqual(
      vers.map((v) => v.auto),
      [true, false, true],
    )
    assert.match(vers[0].name, /^恢复「AI 修改前：做首页.*」之前$/)
    assert.equal(vers[1].name, '第一稿')
    await call('DELETE', `/designs/${webD.id}/versions/${named.id}`)
    assert.equal((await call('GET', `/designs/${webD.id}/versions`)).length, 2)
    await call('DELETE', `/designs/${webD.id}`)
    step('UI 设计：网页 UI（自动布局的控件、网页的提示词、导出 HTML）')

    // 「控件」列表：项目里别的设计的子控件能连同图片加进来
    const other2 = await call('POST', '/designs', { projectId: uiProject.id, kind: 'game', title: 'Shop' })
    const pc = await call('GET', `/designs/projects/${uiProject.id}/components`)
    const fromMenu = pc.find((x) => x.designId === design.id)
    assert.deepEqual(
      fromMenu.components.map((c) => c.Name),
      ['WBP_MenuButton', 'WBP_Tag'],
    )
    assert.ok(fromMenu.images.some((i) => i.id === 'frame'))
    const imported = await call('POST', `/designs/${other2.id}/components/import`, {
      from: design.id,
      name: 'WBP_MenuButton',
    })
    assert.deepEqual(
      imported.components.map((c) => c.Name),
      ['WBP_MenuButton'],
    )
    const copiedFrame = imported.images.find((i) => i.id === 'frame')
    assert.ok(copiedFrame?.variants.length, '用到的图片一起带过来')
    const fileRes = await fetch(`${base}/designs/${other2.id}/files/${copiedFrame.variants[0].file}`)
    assert.equal(fileRes.status, 200, '图片文件也复制过来了')
    await assert.rejects(
      call('POST', `/designs/${other2.id}/components/import`, { from: design.id, name: 'WBP_MenuButton' }),
      /已经有/,
    )
    await call('DELETE', `/designs/${other2.id}`)
    step('UI 设计：「控件」列表列出项目里的子控件，能连同图片加进别的设计')

    await call('DELETE', `/designs/${design.id}`)
    assert.ok(!(await call('GET', '/designs')).some((x) => x.id === design.id))
    assert.ok(!existsSync(path.join(dataDir, 'designs', design.id)))
    // 删除 UI 项目时连同里面的设计一起删
    const d2 = await call('POST', '/designs', { projectId: uiProject.id, kind: 'game', title: 'HUD' })
    // 创建副本和移到别的项目
    const copy = await call('POST', `/designs/${d2.id}/copy`, {})
    assert.notEqual(copy.id, d2.id)
    assert.match(copy.title, /HUD/)
    const other = await call('POST', '/designs/projects', { name: 'Other', path: '' })
    assert.equal((await call('POST', `/designs/${copy.id}/move`, { projectId: other.id })).projectId, other.id)
    await assert.rejects(call('POST', `/designs/${copy.id}/move`, { projectId: 'nope' }), /项目不存在/)
    await call('DELETE', `/designs/projects/${other.id}`)
    assert.ok(!(await call('GET', '/designs')).some((x) => x.id === copy.id))
    await call('PUT', `/designs/projects/${uiProject.id}`, { name: 'Game 2', path: '' })
    assert.equal((await call('GET', '/designs/projects'))[0].name, 'Game 2')
    await call('DELETE', `/designs/projects/${uiProject.id}`)
    assert.deepEqual(await call('GET', '/designs/projects'), [])
    assert.ok(!(await call('GET', '/designs')).some((x) => x.id === d2.id))
    await call('PUT', '/settings', settings)
  }

  // ---- 找不到命令 / 停用 ----
  await call('PUT', '/settings', {
    ...settings,
    clis: {
      ...settings.clis,
      commandcode: cli({ command: path.join(tmp, 'nope', 'cmdc') }),
      codex: cli({ enabled: false }),
    },
  })
  const clis2 = await call('GET', '/clis?refresh=1')
  assert.equal(clis2.find((x) => x.id === 'commandcode').installed, false)
  let missing = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: C.id, prompt: 'hi' })
  missing = await waitDone(missing.id)
  assert.equal(missing.status, 'failed')
  assert.match(
    missing.messages
      .filter((m) => m.error)
      .map((m) => m.text)
      .join('\n'),
    /找不到命令[\s\S]*npm install -g command-code/,
  )
  let disabled = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'hi' })
  disabled = await waitDone(disabled.id)
  assert.equal(disabled.status, 'failed')
  assert.match(
    disabled.messages
      .filter((m) => m.error)
      .map((m) => m.text)
      .join('\n'),
    /停用/,
  )
  step('找不到命令、CLI 被停用时给出明确提示')

  // 从本机 CLI 读取模型列表
  await call('PUT', '/settings', settings)
  const cm = await call('GET', '/clis/codex/models?refresh=1')
  assert.equal(cm.source, 'cli')
  assert.deepEqual(
    cm.models.map((m) => m.id),
    ['fake-pro', 'fake-mini'],
    '隐藏的模型不列出',
  )
  assert.deepEqual(cm.efforts, ['low', 'high', 'ultra'])
  const mm = await call('GET', '/clis/commandcode/models?refresh=1')
  assert.deepEqual(
    mm.models.map((m) => [m.id, m.group]),
    [
      ['fake/flash', 'Open Source'],
      ['fake/pro', 'Open Source'],
      ['gpt-fake', 'OpenAI'],
    ],
  )
  assert.equal(mm.models[0].isDefault, true)
  const pim = await call('GET', '/clis/pi/models?refresh=1')
  assert.equal(pim.source, 'cli')
  assert.deepEqual(
    pim.models.map((m) => [m.id, m.contextWindow, m.efforts.length > 0]),
    [
      ['anthropic/claude-fake', 200000, true],
      ['ollama/qwen-fake:7b', 128000, false],
    ],
  )
  const cl = await call('GET', '/clis/claude/models')
  assert.equal(cl.source, 'builtin')
  assert.ok(cl.models.some((m) => m.id === 'claude-opus-5-5'))
  assert.ok(!cl.models.some((m) => m.id === 'opus'), '不列别名')
  step('从本机 CLI 读取模型列表：Codex 走 app-server，Command Code、Pi 走 --list-models')

  // 目录浏览带上快速入口（Windows 上是各个盘符）
  const listing = await call('GET', `/fs/list?path=${encodeURIComponent(tmp)}`)
  assert.ok(listing.roots.length >= 2 && listing.roots[0].name === '主目录')
  const made = await call('POST', '/fs/mkdir', { parent: tmp, name: 'new-folder' })
  assert.equal(made.path, path.join(tmp, 'new-folder'))
  assert.ok((await call('GET', `/fs/list?path=${encodeURIComponent(tmp)}`)).dirs.some((d) => d.name === 'new-folder'))
  await assert.rejects(call('POST', '/fs/mkdir', { parent: tmp, name: 'new-folder' }), /已经存在/)
  await assert.rejects(call('POST', '/fs/mkdir', { parent: tmp, name: '../escape' }), /不能包含/)
  await assert.rejects(call('POST', '/fs/mkdir', { parent: path.join(tmp, 'nope'), name: 'x' }), /新建文件夹失败/)
  step('目录浏览列出主目录和磁盘，可以新建文件夹（不重名、不能带路径、父目录要存在）')

  // ---- 正式版没有模拟执行：旧设置里的 execution 会被忽略，任务一律真实调用 CLI ----
  await call('PUT', '/settings', { ...settings, execution: 'simulate' })
  assert.equal((await call('GET', '/settings')).execution, undefined)
  assert.equal((await call('GET', '/settings')).openBrowser, true, '默认启动后打开浏览器')
  let sim = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: '真实执行' })
  const before = calls().length
  sim = await waitDone(sim.id)
  assert.equal(sim.status, 'done')
  assert.equal(sim.simulated, false)
  assert.ok(calls().length > before, '任务应当调用 CLI')
  step('没有模拟执行：任务总是调用本机 CLI')

  // 重命名；停止后继续执行
  assert.equal((await call('PATCH', `/tasks/${sim.id}`, { title: '新标题' })).title, '新标题')
  let rs = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: '停一下再继续' })
  await call('POST', `/tasks/${rs.id}/stop`)
  rs = await waitDone(rs.id)
  assert.equal(rs.status, 'stopped')
  await call('POST', `/tasks/${rs.id}/resume`)
  rs = await waitDone(rs.id)
  assert.equal(rs.status, 'done')
  assert.equal(rs.messages.filter((m) => m.role === 'user').length, 1, '继续执行不会新增用户消息')
  await assert.rejects(call('POST', `/tasks/${rs.id}/resume`), /只有失败或停止/)
  step('重命名任务；停止后继续执行')

  // ---- 在设置里安装 / 卸载 CLI ----
  const waitJob = async (id) => {
    for (;;) {
      const j = await call('GET', `/clis/jobs/${id}`)
      if (j.status !== 'running') return j
      await sleep(100)
    }
  }
  let ij = await call('POST', '/clis/claude/install')
  assert.equal(ij.command, 'npm install -g @anthropic-ai/claude-code@latest')
  ij = await waitJob(ij.id)
  assert.equal(ij.status, 'done', ij.error)
  assert.match(ij.log, /added 1 package/)
  assert.match(ij.log, /npm warn/, 'stderr 也记进输出')
  assert.equal(ij.cliStatus.installed, true)
  assert.equal(ij.update, true, '已经装了，这次是更新')
  assert.match(ij.cliStatus.version, /9\.9\.9/, '更新后版本号变了')
  let uj = await waitJob((await call('POST', '/clis/codex/uninstall')).id)
  // 假 CLI 不是 npm 装的，卸载后还能找到：要提示用其他方式卸载
  assert.equal(uj.status, 'failed')
  assert.match(uj.error, /手动删除/)
  assert.deepEqual(
    readLog(log + '.npm')
      .filter((a) => a[0] !== 'prefix' && a[0] !== 'view')
      .map((a) => a.slice(0, 3)),
    [
      ['install', '-g', '@anthropic-ai/claude-code@latest'],
      ['uninstall', '-g', '@openai/codex'],
    ],
  )
  await assert.rejects(call('POST', '/clis/nope/install'), /未知的 Agent/)
  // Pi 改过包名：装新包前先卸掉旧的，否则两个包提供同一个 pi 命令时 npm 会报 EEXIST
  const pj = await waitJob((await call('POST', '/clis/pi/install')).id)
  assert.equal(pj.status, 'done', pj.error)
  assert.equal(pj.command, 'npm install -g @earendil-works/pi-coding-agent@latest')
  assert.deepEqual(
    readLog(log + '.npm')
      .filter((a) => a[0] === 'install' || a[0] === 'uninstall')
      .map((a) => a.slice(0, 3))
      .slice(-2),
    [
      ['uninstall', '-g', '@mariozechner/pi-coding-agent'],
      ['install', '-g', '@earendil-works/pi-coding-agent@latest'],
    ],
  )
  // 切走再回来能找到最近一次操作
  assert.deepEqual(
    (await call('GET', '/clis/jobs')).map((j) => [j.cli, j.status]),
    [
      ['claude', 'done'],
      ['codex', 'failed'],
      ['pi', 'done'],
    ],
  )
  // 有新版本才显示更新：假 npm 说最新是 9.9.9，假 CLI 回到 0.0.1
  rmSync(log + '.ver', { force: true })
  await call('GET', '/clis?refresh=1')
  const up = await call('GET', '/clis/claude/update?refresh=1')
  assert.deepEqual([up.current, up.latest, up.available], ['0.0.1', '9.9.9', true])
  // CLI 的顺序按设置排
  await call('PUT', '/settings', { ...settings, cliOrder: ['commandcode', 'claude'] })
  assert.deepEqual(
    (await call('GET', '/clis')).map((c) => c.id),
    ['commandcode', 'claude', 'codex', 'gemini', 'pi'],
  )
  await call('PUT', '/settings', settings)
  step('设置里安装 / 卸载 CLI：调用 npm、记录输出、完成后重新检测')

  // ---- 版本更新 ----
  const rels = await call('GET', '/app/releases?refresh=1')
  assert.equal(rels.current, '0.11.5')
  assert.equal(rels.packaged, true)
  assert.deepEqual(
    rels.releases.map((r) => [r.tag, r.prerelease]),
    [
      ['v0.11.9-dev', true],
      ['v0.11.8', false],
      ['v0.11.4', false],
    ],
  )
  assert.equal(rels.update.tag, 'v0.11.8', '正式版只提示更新的正式版')
  // 检查的时间和结果记在缓存目录里；不带 refresh 的自动检查 6 小时内直接用上次的结果
  assert.ok(rels.checkedAt, '返回上次检查的时间')
  assert.ok(existsSync(path.join(dataDir, 'cache/updates/releases.json')), '检查结果存到缓存目录')
  assert.equal((await call('GET', '/app/releases')).checkedAt, rels.checkedAt, '6 小时内不重新检查')
  await assert.rejects(call('POST', '/app/install', { tag: 'v9.9.9' }), /找不到版本/)
  const installJob = async (tag) => {
    let j = await call('POST', '/app/install', { tag })
    for (let i = 0; j.status === 'running' && i < 150; i++) {
      await sleep(100)
      j = await call('GET', `/app/install/${j.id}`)
    }
    return j
  }
  // 哈希对不上：不装，程序文件不动
  let aj = await installJob('v0.11.4')
  assert.equal(aj.status, 'failed')
  assert.match(aj.error, /校验不通过/)
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n')
  // 新的服务端加载不了：自动换回原来的文件
  aj = await installJob('v0.11.8')
  assert.equal(aj.status, 'failed')
  assert.match(aj.error, /退回原来的版本/)
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n')
  assert.ok(existsSync(path.join(appDir, 'dist/old.html')), '前端也换回来')
  // 有任务在执行：先下载，任务结束前不替换程序
  const busyTask = await call('POST', '/tasks', { mode: 'chat', agentId: B.id, prompt: 'SLOW 更新等待' })
  let wj = await call('POST', '/app/install', { tag: 'v0.11.9-dev' })
  assert.equal(wj.status, 'running', '任务执行中也能开始下载')
  for (let i = 0; i < 100 && !/等待任务结束/.test(wj.phase); i++) {
    await sleep(100)
    wj = await call('GET', `/app/install/${wj.id}`)
  }
  assert.match(wj.phase, /等待任务结束/, '下载完等任务结束')
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n', '任务结束前不替换程序')
  await call('POST', `/tasks/${busyTask.id}/stop`)
  await waitDone(busyTask.id)
  for (let i = 0; i < 150 && wj.status === 'running'; i++) {
    await sleep(100)
    wj = await call('GET', `/app/install/${wj.id}`)
  }
  aj = wj
  assert.equal(aj.status, 'done', aj.error)
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// new 0.11.9-dev\n')
  assert.ok(existsSync(path.join(appDir, 'dist/index.html')) && !existsSync(path.join(appDir, 'dist/old.html')))
  assert.equal(readFileSync(path.join(appDir, 'data/keep.json'), 'utf8'), '{"keep":true}', '数据不能动')
  assert.equal(readFileSync(path.join(appDir, 'AgentPanel.exe'), 'utf8'), 'tray-0.11.9-dev', '托盘程序换成新的')
  assert.ok(
    readdirSync(appDir).some((n) => n.startsWith('AgentPanel.exe.old-')),
    '上次挪开的旧托盘程序还被占用时，挪到新名字',
  )
  assert.ok(!existsSync(path.join(appDir, 'dist.old')) && !existsSync(path.join(appDir, 'dist.next')))
  // 回到上一个版本：和当前版本互换，换完还能再换回来
  assert.equal((await call('GET', '/app/version')).previous, '0.11.5')
  assert.deepEqual(await call('POST', '/app/rollback'), { version: '0.11.5' })
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n')
  assert.ok(existsSync(path.join(appDir, 'dist/old.html')))
  assert.equal(readFileSync(path.join(dataDir, 'cache/updates/previous/server.mjs'), 'utf8'), '// new 0.11.9-dev\n')
  step('版本更新：读取 GitHub 上的包、校验哈希，替换程序文件、保留数据；新版本加载不了自动退回，也能手动回到上一个版本')

  // ---- 项目说明文件：读、写（只认白名单里的文件名）、AI 优化 ----
  {
    let docs = await call('GET', `/project-docs/${project.id}`)
    assert.equal(docs.dir, projectDir)
    assert.ok(docs.files.some((f) => f.path === 'AGENTS.md' && !f.exists))
    const saved = await call('PUT', `/project-docs/${project.id}`, { path: '.claude/CLAUDE.md', content: '# 约定\n' })
    assert.equal(saved.exists, true)
    assert.equal(readFileSync(path.join(projectDir, '.claude/CLAUDE.md'), 'utf8'), '# 约定\n')
    await assert.rejects(call('PUT', `/project-docs/${project.id}`, { path: '../x.md', content: 'x' }), /400/)
    assert.ok(!existsSync(path.join(projectDir, '../x.md')), '不能写到白名单外')
    let job = await call('POST', `/project-docs/${project.id}/optimize`, {
      path: 'AGENTS.md',
      content: '# 项目\n',
      cli: 'commandcode',
    })
    for (let i = 0; job.status === 'running' && i < 100; i++) {
      await sleep(100)
      job = await call('GET', `/doc-jobs/${job.id}`)
    }
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.text, '补上了常用命令。')
    assert.ok(
      job.result.startsWith('# 项目\n') && job.result.includes('## 常用命令\n\n```bash\nnpm test\n```'),
      job.result,
    )
    docs = await call('GET', `/project-docs/${project.id}`)
    assert.ok(!docs.files.find((f) => f.path === 'AGENTS.md').exists, '优化不直接写文件')
    rmSync(path.join(projectDir, '.claude'), { recursive: true })
    step('项目说明文件：读写、拒绝白名单外的路径、AI 优化')
  }

  // ---- AI 处理报错：整理成第一句话（带上相关的安装情况），在聊天里新建一个对话去排查 ----
  {
    const base = await call('GET', '/settings')
    await call('PUT', '/settings', { ...base, assist: { ...base.assist, cli: 'commandcode' } })
    await assert.rejects(call('POST', '/ai-fix', { title: '' }), /400/)
    const s = await call('POST', '/ai-fix', {
      title: 'Pi：卸载没有成功',
      error: '还能找到 pi.cmd',
      command: 'npm uninstall -g @mariozechner/pi-coding-agent',
      output: 'up to date in 364ms',
      // 对话里的报错会带上项目路径和出错前后的对话
      conversation: '用户：帮我把 Pi 卸载干净\n\nAI：好的，先看安装位置\n\n报错：还能找到 pi.cmd',
      cwd: 'F:\\Project\\demo',
      topic: 'cli:pi',
    })
    assert.equal(s.cli, 'commandcode')
    for (const part of [
      '出了什么问题：Pi：卸载没有成功',
      '还能找到 pi.cmd',
      'npm uninstall -g',
      'up to date in 364ms',
      '相关的 CLI：Pi',
      '报错前后的对话：',
      'AI：好的，先看安装位置',
      '相关目录（项目路径）：F:\\Project\\demo',
    ])
      assert.ok(s.prompt.includes(part), part)
    let task = await call('POST', '/tasks', {
      projectId: '',
      mode: 'chat',
      agentId: '',
      cli: s.cli,
      model: s.model,
      prompt: s.prompt,
      askUser: true,
    })
    task = await waitDone(task.id)
    assert.equal(task.status, 'done')
    assert.ok(
      (await call('GET', '/tasks')).some((x) => x.id === task.id),
      '排查的对话留在聊天列表里',
    )
    await call('DELETE', `/tasks/${task.id}`)
    await call('PUT', '/settings', base)
    step('AI 处理报错：整理报错、命令、输出和相关的安装情况，在聊天里新建对话排查')
  }

  // ---- 账号和 API：登录、保存、切换、登出；用 API 时把地址和密钥交给 CLI，模型只列这个 API 的 ----
  {
    const base0 = await call('GET', '/settings')
    const withAuth = (extra = {}) => ({
      ...base0,
      ...extra,
      clis: Object.fromEntries(
        ['claude', 'codex', 'commandcode', 'gemini', 'pi'].map((id) => [
          id,
          { ...base0.clis[id], env: [{ key: 'FAKE_AUTH', value: id }], ...(extra.clis?.[id] ?? {}) },
        ]),
      ),
    })
    await call('PUT', '/settings', withAuth())
    const list = async (cli) => (await call('GET', '/accounts')).find((x) => x.cli === cli)
    const waitLogin = async (cli) => {
      for (let i = 0; i < 100; i++) {
        const j = await call('GET', `/accounts/${cli}/login`)
        if (j && j.status !== 'running') return j
        await sleep(150)
      }
      throw new Error('登录没有结束')
    }
    assert.deepEqual(
      (await call('GET', '/accounts')).map((x) => [x.cli, x.live.loggedIn, x.accounts.length]),
      [
        ['claude', false, 0],
        ['codex', false, 0],
        ['commandcode', false, 0],
        ['gemini', false, 0],
        ['pi', false, 0],
      ],
      '一开始都没登录',
    )
    // Codex：登录两个账号，凭据文件换成新的，之前的自动存下来
    const authFile = path.join(homeDir, '.codex', 'auth.json')
    const emailOf = () =>
      JSON.parse(Buffer.from(JSON.parse(readFileSync(authFile, 'utf8')).tokens.id_token.split('.')[1], 'base64url'))
        .email
    let j = await call('POST', '/accounts/codex/login')
    assert.equal(j.status, 'running')
    j = await waitLogin('codex')
    assert.equal(j.status, 'done', JSON.stringify(j))
    assert.match(j.url, /^https:\/\/example\.com\/oauth\/authorize/, '登录网址（localhost 的回调地址不算）')
    let c = await list('codex')
    assert.deepEqual(
      [c.live.loggedIn, c.live.email, c.unsaved, c.accounts.map((a) => [a.email, a.active])],
      [true, 'fake1@example.com', false, [['fake1@example.com', true]]],
    )
    await call('POST', '/accounts/codex/login')
    assert.equal((await waitLogin('codex')).status, 'done')
    c = await list('codex')
    assert.deepEqual(
      c.accounts.map((a) => [a.email, a.active]),
      [
        ['fake1@example.com', false],
        ['fake2@example.com', true],
      ],
      '登录第二个账号：第一个还在，第二个是现在用的',
    )
    assert.equal(emailOf(), 'fake2@example.com')
    // 切换回第一个：凭据文件换回去
    const first = c.accounts[0]
    c = await call('POST', '/accounts/codex/switch', { id: first.id })
    assert.equal(emailOf(), 'fake1@example.com')
    assert.deepEqual(
      c.accounts.map((a) => a.active),
      [true, false],
    )
    // 改名、登出（凭据文件没了，账号还在）、再切回来
    c = await call('PATCH', `/accounts/codex/accounts/${first.id}`, { name: '工作号' })
    assert.equal(c.accounts[0].name, '工作号')
    c = await call('POST', '/accounts/codex/logout')
    assert.deepEqual([c.live.loggedIn, c.accounts.length, existsSync(authFile)], [false, 2, false])
    c = await call('POST', '/accounts/codex/switch', { id: first.id })
    assert.deepEqual([c.live.loggedIn, c.live.email, emailOf()], [true, 'fake1@example.com', 'fake1@example.com'])
    c = await call('DELETE', `/accounts/codex/accounts/${c.accounts[1].id}`)
    assert.equal(c.accounts.length, 1)
    // Claude Code：除了凭据文件，账号信息在 .claude.json 的 oauthAccount 里，别的内容不动；登出后只去掉它
    const claudeJson = path.join(homeDir, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({ userID: 'u-1', theme: 'dark' }))
    await call('POST', '/accounts/claude/login')
    assert.equal((await waitLogin('claude')).status, 'done')
    c = await list('claude')
    assert.deepEqual([c.live.email, c.accounts.length], ['fake3@example.com', 1])
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).userID, 'u-1', '.claude.json 里别的内容原样保留')
    await call('POST', '/accounts/claude/logout')
    const left = JSON.parse(readFileSync(claudeJson, 'utf8'))
    assert.deepEqual(
      [left.oauthAccount, left.theme, existsSync(path.join(homeDir, '.claude', '.credentials.json'))],
      [undefined, 'dark', false],
    )
    // Gemini CLI：登录后 CLI 不退出，凭据一变面板就算登录成功并停掉它；登录前先写好登录方式
    await call('POST', '/accounts/gemini/login')
    assert.equal((await waitLogin('gemini')).status, 'done')
    assert.equal((await list('gemini')).live.email, 'fake4@example.com')
    assert.equal(
      JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'settings.json'), 'utf8')).security.auth.selectedType,
      'oauth-personal',
    )
    // Command Code：凭据里认不出邮箱，用起的名字；同一份凭据不重复保存
    await call('POST', '/accounts/commandcode/login')
    assert.equal((await waitLogin('commandcode')).status, 'done')
    c = await call('POST', '/accounts/commandcode/save', { name: '备用' })
    assert.deepEqual(
      c.accounts.map((a) => a.name),
      ['Command Code 账号 1'],
      '已经保存过的凭据不重复保存',
    )

    // API：读模型列表（在服务端请求），选用后模型下拉只列这个 API 的模型，地址和密钥按 CLI 的规则传进去
    const apiSrv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.headers.authorization !== 'Bearer sk-test')
        return void res.writeHead(401).end(JSON.stringify({ error: { message: 'bad key' } }))
      res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] }))
    })
    await new Promise((r) => apiSrv.listen(0, '127.0.0.1', r))
    // 这个临时 server 也要登记：后面的断言一失败，它留着就会让进程退不出去
    const closeApiSrv = onExit(() => {
      apiSrv.closeAllConnections()
      apiSrv.close()
    })
    const apiBase = `http://127.0.0.1:${apiSrv.address().port}/v1`
    // name 必填（服务端按厂家名称查默认地址和余额接口），页面传的是整份 API 配置
    const got = await call('POST', '/accounts/api-models', {
      name: 'OpenAI',
      protocol: 'openai-chat',
      baseUrl: apiBase,
      apiKey: 'sk-test',
    })
    assert.deepEqual(got.models, ['m-a', 'm-b'])
    await assert.rejects(
      call('POST', '/accounts/api-models', {
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: apiBase,
        apiKey: 'wrong',
      }),
      /401/,
    )
    // 缺 name 要明确报错，不能静默当成空名字（那样厂家默认地址和余额接口都查不到）
    await assert.rejects(
      call('POST', '/accounts/api-models', { protocol: 'openai-chat', baseUrl: apiBase, apiKey: 'sk-test' }),
      /at name/,
    )
    // 余额接口：地址只按厂家名称取，不支持余额的厂家、缺名称、缺密钥都要明确报错
    await assert.rejects(call('POST', '/accounts/api-balance', { name: '中转 A', apiKey: 'sk-test' }), /不支持余额查询/)
    await assert.rejects(call('POST', '/accounts/api-balance', { apiKey: 'sk-test' }), /at name/)
    await assert.rejects(call('POST', '/accounts/api-balance', { name: 'DeepSeek', apiKey: '' }), /先填密钥/)
    closeApiSrv()
    const apis = [
      {
        id: 'ap1',
        name: '中转 A',
        provider: 'relay-a',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'sk-relay',
        authHeader: 'x-api-key',
        models: ['relay-1', 'relay-2'],
      },
      {
        id: 'ap2',
        name: 'Claude 中转',
        provider: 'claude-relay',
        protocol: 'anthropic',
        baseUrl: 'https://claude.example',
        apiKey: 'sk-ant',
        authHeader: 'bearer',
        models: ['claude-x'],
      },
    ]
    await call(
      'PUT',
      '/settings',
      withAuth({ apis, clis: { codex: { authMode: 'api', apiId: 'ap1' }, claude: { authMode: 'api', apiId: 'ap2' } } }),
    )
    const cm = await call('GET', '/clis/codex/models?refresh=1')
    assert.deepEqual(
      [cm.auth, cm.from, cm.models.map((m) => m.id), cm.models[0].isDefault],
      ['api', '中转 A', ['relay-1', 'relay-2'], true],
      'API 模式只列这个 API 的模型',
    )
    const accountModels = await call('GET', '/clis/gemini/models?refresh=1')
    assert.notEqual(accountModels.auth, 'api', '账号模式不受影响')
    const before = calls().length
    const t1 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'codex',
      model: 'relay-1',
      prompt: '用 API 跑',
    })
    await waitDone(t1.id)
    const t2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'claude',
      model: 'claude-x',
      prompt: '用 API 跑 claude',
    })
    await waitDone(t2.id)
    const used = calls().slice(before)
    const codexCall = used.find((x) => x.kind === 'codex')
    const codexConfig = readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8')
    assert.ok(codexConfig.includes('model_provider = "relay-a"'), 'Codex 的 provider 写进 config.toml')
    assert.ok(codexConfig.includes('[model_providers.relay-a]'))
    assert.ok(codexConfig.includes('base_url = "https://relay.example/v1"'))
    assert.ok(codexConfig.includes('wire_api = "responses"'))
    assert.ok(codexConfig.includes('experimental_bearer_token = "sk-relay"'), '密钥也写进配置文件')
    assert.ok(!codexCall.args.some((a) => a.includes('model_providers')), '不再用 -c 传接口')
    assert.ok(!codexCall.args.includes('model_provider="relay-a"'))
    assert.equal(codexCall.apiEnv.agentpanel, undefined, '不再把密钥放在环境变量里')
    assert.ok(!codexCall.args.join(' ').includes('sk-relay'))
    const claudeCall = used.find((x) => x.kind === 'claude')
    const claudeSettings = JSON.parse(readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    assert.equal(claudeSettings.env?.ANTHROPIC_BASE_URL, 'https://claude.example')
    assert.equal(claudeSettings.env?.ANTHROPIC_AUTH_TOKEN, 'sk-ant', 'Bearer 方式写进 settings.json')
    assert.deepEqual(claudeCall.apiEnv.anthropic, [null, null, null], '不再走环境变量')
    // 协议对不上的 API 不会交给 CLI（Codex 选了 Anthropic 的 API）
    await call('PUT', '/settings', withAuth({ apis, clis: { codex: { authMode: 'api', apiId: 'ap2' } } }))
    assert.notEqual((await call('GET', '/clis/codex/models?refresh=1')).auth, 'api')
    assert.ok(
      !readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8').includes('model_providers.relay-a'),
      '协议对不上时清掉上一次写进去的 provider',
    )
    // 改用 API 需要改配置文件的 CLI：Gemini CLI 选了 gemini-api-key，改回账号时还原；Command Code 写进自定义接口
    await call(
      'PUT',
      '/settings',
      withAuth({
        apis: [
          {
            id: 'g1',
            name: 'Gemini Key',
            protocol: 'gemini',
            baseUrl: '',
            apiKey: 'gk',
            authHeader: 'x-api-key',
            models: ['gem-1'],
          },
          {
            id: 'c1',
            name: 'CC 接口',
            provider: 'cc',
            protocol: 'openai-chat',
            baseUrl: 'https://cc.example/v1',
            apiKey: 'ck',
            authHeader: 'x-api-key',
            models: ['cc-1'],
          },
        ],
        clis: {
          gemini: { authMode: 'api', apiId: 'g1' },
          commandcode: { authMode: 'api', apiId: 'c1' },
          pi: { authMode: 'api', apiId: 'c1' },
        },
      }),
    )
    const g = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'gemini',
      model: 'gem-1',
      prompt: '用 gemini API',
    })
    await waitDone(g.id)
    const geminiSettings = () => JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'settings.json'), 'utf8'))
    const geminiEnvFile = path.join(homeDir, '.gemini', '.env')
    const geminiEnv = () => readFileSync(geminiEnvFile, 'utf8')
    assert.equal(geminiSettings().security.auth.selectedType, 'gemini-api-key')
    assert.match(geminiEnv(), /GEMINI_API_KEY=gk/, '密钥写进 .gemini/.env')
    assert.match(geminiEnv(), /GOOGLE_GEMINI_BASE_URL=/)
    assert.equal(calls().findLast((x) => x.kind === 'gemini').apiEnv.gemini[0], null, '不再走环境变量')
    assert.equal(
      calls().findLast((x) => x.kind === 'gemini').apiEnv.trust,
      'true',
      'Gemini CLI 无界面运行要信任工作目录，否则报「not running in a trusted directory」',
    )
    const cc = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      model: 'cc-1',
      prompt: '用 cc API',
    })
    await waitDone(cc.id)
    const ccFile = path.join(homeDir, '.commandcode', 'settings.json')
    const ccProviders = path.join(homeDir, '.commandcode', 'providers.json')
    assert.deepEqual(JSON.parse(readFileSync(ccProviders, 'utf8')).provider.cc, {
      name: 'CC 接口',
      baseURL: 'https://cc.example/v1',
      apiKey: 'ck',
      api: 'openai-completions',
      models: { 'cc-1': {} },
    })
    assert.equal(JSON.parse(readFileSync(ccFile, 'utf8')).provider?.agentpanel, undefined, '不再写旧的 settings.json')
    const ccCall = calls().findLast((x) => x.kind === 'commandcode')
    assert.equal(ccCall.apiEnv.agentpanel, undefined, '密钥不再走环境变量')
    // 两种方式的模型下拉各列各的：API 方式只列这个 API 的；账号方式（还没保存就先读）不列 BYOK 和 API 的模型
    assert.deepEqual(
      (await call('GET', '/clis/commandcode/models?refresh=1')).models.map((m) => m.id),
      ['cc/cc-1'],
    )
    const ccAccount = await call('GET', '/clis/commandcode/models?auth=account')
    assert.deepEqual(
      [ccAccount.auth, ccAccount.models.map((m) => m.id)],
      ['account', ['fake/flash', 'fake/pro', 'gpt-fake']],
      '账号方式只列账号的模型',
    )
    assert.ok(!ccCall.args.join(' ').includes('ck'))
    // Pi：自己接的接口写进 models.json 的 providers，模型 ID 自带 provider
    const pa = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'pi',
      model: 'cc-1',
      prompt: '用 pi API',
    })
    await waitDone(pa.id)
    const piModels = path.join(homeDir, '.pi', 'agent', 'models.json')
    assert.deepEqual(JSON.parse(readFileSync(piModels, 'utf8')).providers.cc, {
      baseUrl: 'https://cc.example/v1',
      api: 'openai-completions',
      apiKey: 'ck',
      models: [{ id: 'cc-1' }],
    })
    const piCall = calls().findLast((x) => x.kind === 'pi')
    assert.equal(piCall.apiEnv.agentpanel, undefined, '密钥不再走环境变量')
    assert.ok(!piCall.args.includes('--provider'), '不再额外传 provider，模型 ID 自带前缀')
    assert.equal(piCall.args[piCall.args.indexOf('--model') + 1], 'cc/cc-1')
    await call(
      'PUT',
      '/settings',
      withAuth({
        apis: [],
        clis: { gemini: { authMode: 'account' }, commandcode: { authMode: 'account' }, pi: { authMode: 'account' } },
      }),
    )
    const g2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'gemini',
      prompt: '改回账号',
    })
    await waitDone(g2.id)
    assert.equal(geminiSettings().security.auth.selectedType, 'oauth-personal', '改回账号还原登录方式')
    assert.ok(!geminiEnv().includes('GEMINI_API_KEY'), '改回账号删掉 .env 里的 API 配置')
    assert.equal(
      JSON.parse(readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8')).env?.ANTHROPIC_AUTH_TOKEN,
      undefined,
      '改回账号删掉 Claude settings.json 里的 API 配置',
    )
    const cc2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      prompt: '改回账号 cc',
    })
    await waitDone(cc2.id)
    assert.equal(JSON.parse(readFileSync(ccFile, 'utf8')).provider?.agentpanel, undefined)
    assert.equal(JSON.parse(readFileSync(ccProviders, 'utf8')).provider?.cc, undefined)
    const pa2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'pi',
      prompt: '改回账号 pi',
    })
    await waitDone(pa2.id)
    assert.equal(JSON.parse(readFileSync(piModels, 'utf8')).providers?.cc, undefined, '改回账号删掉接口')
    // 凭据不进数据导出
    const backup = await call('GET', '/data/export?kinds=config,projects,tasks,uploads')
    assert.ok(!Object.keys(backup.files).some((f) => f.startsWith('accounts')), '账号凭据不在备份里')
    await call('PUT', '/settings', base0)
    step(
      '账号和 API：登录、保存、切换、登出（Claude Code 的 .claude.json 只动账号信息）；API 模式把地址和密钥写进 CLI 自己的配置、执行只传模型、协议对不上不用',
    )
  }

  // ---- 只接受本机页面的请求 ----
  const raw = (method, url, headers, body) =>
    new Promise((resolve, reject) => {
      const u = new URL(base + url)
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end(body)
    })
  assert.equal(
    await raw('GET', '/projects', { host: 'evil.example:' + new URL(base).port }),
    403,
    'DNS 重绑定：外部域名的 Host',
  )
  assert.equal(await raw('GET', '/projects', { origin: 'https://evil.example' }), 403, '外部网站的 Origin')
  assert.equal(await raw('POST', '/assist', { 'content-type': 'text/plain' }, '{}'), 415, '不是 JSON 的写请求')
  assert.equal(await raw('GET', '/projects', { origin: 'http://localhost:5173' }), 200, '本机页面可以访问')
  step('只接受本机页面的请求：拦下外部 Host、外部 Origin 和非 JSON 的写请求')

  // ---- 访问令牌 ----
  {
    const token = readFileSync(path.join(dataDir, 'access-token'), 'utf8').trim()
    const json = { 'content-type': 'application/json' }
    const cur = await call('GET', '/settings')
    const on = await fetch(base + '/settings', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ ...cur, requireToken: true }),
    })
    const cookie = (on.headers.get('set-cookie') ?? '').split(';')[0]
    assert.equal(cookie, `agent_panel_token=${token}`, '打开令牌的浏览器拿到 Cookie')
    assert.equal((await fetch(base + '/projects')).status, 401, '没带令牌被拒绝')
    assert.equal((await fetch(base + '/projects', { headers: { cookie } })).status, 200)
    // 带令牌的地址：发 Cookie 后跳到去掉令牌的地址
    const r = await fetch(base.replace('/api', '') + `/tasks?token=${token}&x=1`, { redirect: 'manual' })
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/tasks?x=1')
    assert.match(r.headers.get('set-cookie') ?? '', /agent_panel_token=/)
    assert.equal((await fetch(base.replace('/api', '') + '/?token=wrong', { redirect: 'manual' })).status, 401)
    await fetch(base + '/settings', { method: 'PUT', headers: { ...json, cookie }, body: JSON.stringify(cur) })
    assert.equal((await fetch(base + '/projects')).status, 200, '关掉后不再要求')
  }
  step('访问令牌：打开后没带令牌的请求被拒绝，用带令牌的地址打开的浏览器拿到 Cookie')

  // 没有提问通道的 CLI（Command Code、Gemini CLI）：面板临时接一个 ask_user 工具，等用户回答后交回，项目里原有的 MCP 配置用完还原
  {
    const mcpFile = path.join(project.path, '.mcp.json')
    const original = JSON.stringify({ mcpServers: { mine: { command: 'x' } } })
    writeFileSync(mcpFile, original)
    for (const cli of ['commandcode', 'gemini', 'pi']) {
      const before = readLog(log + '.askbridge').length
      const t = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: '',
        cli,
        askUser: true,
        prompt: `想做什么 FAKE_ASK:${JSON.stringify({ questions: [{ header: '方向', question: '想做什么？', options: [{ label: '修 bug（推荐）' }, { label: '写文档' }] }] })}`,
      })
      let req
      for (let i = 0; i < 100 && !req; i++) {
        req = (await call('GET', `/tasks/${t.id}`)).requests[0]
        if (!req) await sleep(100)
      }
      assert.ok(req, `${cli}：弹出了提问`)
      assert.equal(req.kind, 'question')
      assert.deepEqual(req.options, ['修 bug（推荐）', '写文档'])
      await call('POST', `/tasks/${t.id}/requests/${req.id}`, { allow: true, answers: ['写文档'] })
      const done = await waitDone(t.id)
      assert.equal(done.status, 'done')
      const rec = readLog(log + '.askbridge')
        .slice(before)
        .at(-1)
      // Command Code 现在用 RPC 的 turn/steer 插话；notes 与 steer 不再互斥，所以 read_user_notes 也注册了：
      // steer 在 CLI 不在活跃轮次时返回 false，没这个兜底通道补充消息会丢
      // 编排工具也挂在同一个面板服务上，这里只看提问这一组
      assert.deepEqual(
        rec.tools.filter((n) => ['ask_user', 'wait_user_message', 'read_user_notes'].includes(n)),
        cli === 'commandcode' ? ['ask_user', 'read_user_notes', 'wait_user_message'] : ['ask_user'],
      )
      assert.match(rec.got, /想做什么？ → 写文档/, '回答交回给了模型')
      assert.ok(rec.hint, '提示里告诉模型有 ask_user')
      assert.ok(done.messages.some((m) => /收到：用户的回答/.test(m.text)))
    }
    assert.equal(readFileSync(mcpFile, 'utf8'), original, '项目里原有的 MCP 配置还原')
    assert.ok(!existsSync(path.join(project.path, '.gemini', 'settings.json')), '临时写的配置删掉了')
    assert.ok(!existsSync(path.join(project.path, '.pi')), 'Pi 的桥接扩展不写进项目')
    const piExt = calls()
      .filter((x) => x.kind === 'pi')
      .map((x) => x.args[x.args.indexOf('-e') + 1])
      .find((x) => x && /agent-panel-panel/.test(x))
    assert.ok(piExt && path.isAbsolute(piExt) && piExt.startsWith(dataDir), `桥接扩展在面板的数据目录里：${piExt}`)
    assert.ok(!existsSync(piExt), 'Pi 的桥接扩展用完删掉了')
    // 提问开关关着：不弹出，工具让模型自己选
    const off = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: `FAKE_ASK:${JSON.stringify({ questions: [{ question: '选哪个？', options: [{ label: 'a' }] }] })}`,
    })
    const offDone = await waitDone(off.id)
    assert.equal(offDone.requests.length, 0)
    assert.match(readLog(log + '.askbridge').at(-1).got, /不回答问题/)
    rmSync(mcpFile, { force: true })
  }
  step('没有提问通道的 CLI：临时接 ask_user 工具，回答后交回模型，开关关着时让模型自己选，项目里原有的配置还原')

  // 执行中补充：Command Code 走常驻 RPC 的 turn/steer，已经在「插话」那一节覆盖；
  // MCP 的 read_user_notes 拉取通道由 server/ask-mcp.test.ts 单独测试

  // 对话页开着时：CLI 回复完停在 wait_user_message 上，下一句直接交给同一个进程；切走宽限到了就结束
  {
    const before = readLog(log + '.wait').length
    let w = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: 'FAKE_WAIT 先看代码',
    })
    // 打开对话页时前端会先报已读，再报页面开着
    await call('POST', `/tasks/${w.id}/seen`, {})
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: true })
    for (let i = 0; i < 100; i++) {
      w = await call('GET', `/tasks/${w.id}`)
      if (w.awaitingUser) break
      await sleep(100)
    }
    assert.ok(w.awaitingUser, '回复完停在等下一句上')
    assert.equal(w.working, false, '等下一句不算执行中')
    assert.ok(w.turnDoneAt, 'CLI 完成一轮时记了时间')
    await call('POST', `/tasks/${w.id}/messages`, { text: '接着看看测试' })
    w = await waitDone(w.id, 30000)
    assert.equal(w.status, 'done')
    assert.equal(w.awaitingUser, false)
    assert.equal('queue' in w, false, '不再有排队字段')
    const rec = readLog(log + '.wait')
      .slice(before)
      .at(-1)
    assert.match(rec.got, /接着看看测试/)
    assert.ok(rec.hint, '提示里告诉模型可以等下一句')
    const at = w.messages.findIndex((m) => m.role === 'user' && m.text === '接着看看测试')
    assert.ok(at > 0, '用户消息记进对话')
    assert.ok(
      w.messages.slice(at + 1).some((m) => m.role === 'agent' && /等到的下一句/.test(m.text)),
      'AI 在用户消息下面继续输出',
    )

    // 页面切走：宽限到了让还在等的 CLI 结束这一轮
    let left = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: 'FAKE_WAIT 等一会儿',
    })
    await call('POST', `/tasks/${left.id}/presence`, { viewerId: 'e2e', active: true })
    for (let i = 0; i < 100; i++) {
      left = await call('GET', `/tasks/${left.id}`)
      if (left.awaitingUser) break
      await sleep(100)
    }
    assert.ok(left.awaitingUser, '第二个对话也停在等下一句上')
    assert.equal(left.working, false, '等下一句不算执行中')
    assert.ok(left.turnDoneAt, '完成一轮时记了时间')
    await call('POST', `/tasks/${left.id}/presence`, { viewerId: 'e2e', active: false })
    left = await waitDone(left.id, 15000)
    assert.equal(left.status, 'done', '切走宽限到了，CLI 自己结束')
    assert.equal(left.awaitingUser, false)
    assert.equal(left.working, false)
  }
  step('对话页开着时 CLI 停在等下一句上：下一句直接交给同一个进程，切走后结束')

  // 对话页开着、模型没有调用 wait_user_message：面板自己把进程留着，回来发消息不再启动新进程
  {
    const beforePids = new Set(readLog(log).map((x) => x.pid))
    let w = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: '先看代码',
    })
    // 打开对话页时前端会先报已读，再报页面开着
    await call('POST', `/tasks/${w.id}/seen`, {})
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: true })
    for (let i = 0; i < 120; i++) {
      w = await call('GET', `/tasks/${w.id}`)
      if (w.awaitingUser) break
      await sleep(100)
    }
    assert.ok(w.awaitingUser, '回复完停在等下一句上，不靠模型调用等待工具')
    assert.equal(w.working, false, '等下一句不算执行中')
    assert.ok(w.turnDoneAt, 'CLI 完成一轮时记了时间')

    // 回来发消息：同一个进程接着跑，不再启动新的 CLI（跑完这一轮又会保活，所以任务还是 running）
    const beforeMsgs = w.messages.length
    await call('POST', `/tasks/${w.id}/messages`, { text: '接着说' })
    for (let i = 0; i < 120; i++) {
      w = await call('GET', `/tasks/${w.id}`)
      // 新的一句已经回复完、又回到等下一句：这一轮处理过了
      if (w.awaitingUser && w.messages.length > beforeMsgs) break
      await sleep(100)
    }
    assert.ok(w.messages.length > beforeMsgs, '用户消息和回复都记进对话')
    const pids = readLog(log)
      .filter((x) => !beforePids.has(x.pid))
      .map((x) => x.pid)
    assert.equal(new Set(pids).size, 1, '整个过程只启动了一个 CLI 进程')
    assert.equal('queue' in w, false, '不再有排队字段')
    const at = w.messages.findIndex((m) => m.role === 'user' && m.text === '接着说')
    assert.ok(at > 0, '用户消息记进对话')
    assert.ok(
      w.messages.slice(at + 1).some((m) => m.role === 'agent' && m.text.trim()),
      'AI 在用户消息下面继续输出',
    )

    // 用户走开（过了宽限）：保活结束，进程退出
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: false })
    w = await waitDone(w.id, 15000)
    assert.equal(w.status, 'done', '切走宽限到了，CLI 自己结束')
  }
  step('模型没调用等待工具时，面板也把进程留着：回来发消息复用同一个 CLI')

  // 预热接口本身：切换 CLI/模型后服务端会用它重开进程；打开对话页不再自动调用它
  {
    let w = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: '普通对话',
    })
    w = await waitDone(w.id, 30000)
    assert.equal(w.status, 'done')
    assert.ok(w.sessions[''], '第一轮留下了会话')
    assert.ok(w.turnDoneAt, '第一轮完成时记了时间')
    const doneAt = w.turnDoneAt
    const beforeMsgs = w.messages.length

    w = await call('POST', `/tasks/${w.id}/prewarm`, {})
    assert.ok(w.status === 'running' || w.awaitingUser, '打开对话就开始启动')
    assert.equal(w.working, false, '预热不算执行中')
    for (let i = 0; i < 100; i++) {
      w = await call('GET', `/tasks/${w.id}`)
      if (w.awaitingUser) break
      await sleep(50)
    }
    assert.ok(w.awaitingUser, '预热完停在等下一句上')
    assert.equal(w.prewarming, false)
    assert.equal(w.working, false, '预热/等下一句不算执行中')
    assert.equal(w.messages.length, beforeMsgs, '预热不往对话里加消息')
    assert.equal(w.turnDoneAt, doneAt, '预热本身不算完成一轮')

    // 预热好了再发消息：直接交给同一个进程，不用重新启动
    await call('POST', `/tasks/${w.id}/messages`, { text: '预热后直接问' })
    w = await waitDone(w.id, 30000)
    const at = w.messages.findIndex((m) => m.role === 'user' && m.text === '预热后直接问')
    assert.ok(at > 0, '用户消息记进对话')
    assert.ok(
      w.messages.slice(at + 1).some((m) => m.role === 'agent' && /等到的下一句/.test(m.text)),
      '模型在用户消息下面继续输出',
    )
    assert.notEqual(w.turnDoneAt, doneAt, '真正处理了用户消息才算完成一轮')
    const askedDoneAt = w.turnDoneAt
    const askedUpdatedAt = w.updatedAt

    // 再预热一次，然后切走：宽限到了结束，不在后台一直占着
    w = await call('POST', `/tasks/${w.id}/prewarm`, {})
    for (let i = 0; i < 100; i++) {
      w = await call('GET', `/tasks/${w.id}`)
      if (w.awaitingUser) break
      await sleep(50)
    }
    assert.ok(w.awaitingUser, '再次打开也预热好了')
    // 打开过这个对话：之后切走才会按宽限期回收；没打开过的话会一直留着等用户回来
    await call('POST', `/tasks/${w.id}/seen`, {})
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: false })
    w = await waitDone(w.id, 15000)
    assert.equal(w.status, 'done')
    assert.equal(w.prewarming, false)
    assert.equal(w.working, false)
    assert.equal(w.turnDoneAt, askedDoneAt, '切走让预热退出不算完成一轮')
    assert.equal(w.updatedAt, askedUpdatedAt, '预热退出不改列表时间')
  }
  step('预热接口：切换 CLI/模型后按新选择重开进程，停在等下一句；打开对话页不再自动预热')

  // Skills / 命令库：读写各 CLI 用户目录下的 Skill 和命令，复制给别的 CLI 时命令自动换格式
  {
    const lib = (kind) => call('GET', `/library?kind=${kind}`)
    const put = (b) => call('PUT', '/library/file', b)
    await put({
      cli: 'claude',
      kind: 'skill',
      name: 'lib-demo',
      create: true,
      content: '---\nname: lib-demo\ndescription: 库里的测试 Skill\n---\n\n步骤\n',
    })
    const skillDir = path.join(homeDir, '.claude', 'skills', 'lib-demo')
    writeFileSync(path.join(skillDir, 'notes.md'), '附带文件')
    const listed = (await lib('skill')).items.find((i) => i.cli === 'claude' && i.name === 'lib-demo')
    assert.equal(listed.description, '库里的测试 Skill')
    assert.deepEqual((await call('GET', '/library/file?cli=claude&kind=skill&name=lib-demo')).files, ['notes.md'])
    await assert.rejects(
      put({ cli: 'claude', kind: 'skill', name: 'lib-demo', create: true, content: 'x' }),
      /已经有了/,
    )
    await assert.rejects(put({ cli: 'claude', kind: 'skill', name: '../evil', content: 'x' }), /名字/)
    // 复制给 Codex：整个文件夹带过去；已有同名的不覆盖
    let cp = await call('POST', '/library/copy', { cli: 'claude', kind: 'skill', name: 'lib-demo', to: ['codex'] })
    assert.deepEqual(cp.done, ['codex'])
    assert.ok(existsSync(path.join(homeDir, '.codex', 'skills', 'lib-demo', 'notes.md')))
    cp = await call('POST', '/library/copy', { cli: 'claude', kind: 'skill', name: 'lib-demo', to: ['codex'] })
    assert.deepEqual(cp.skipped, ['codex'])
    // 命令：Claude Code 是 md，Gemini CLI 是 toml
    await put({
      cli: 'claude',
      kind: 'command',
      name: 'lib-cmd',
      create: true,
      content: '---\ndescription: 测试命令\n---\n做点事 $ARGUMENTS\n',
    })
    await call('POST', '/library/copy', { cli: 'claude', kind: 'command', name: 'lib-cmd', to: ['gemini'] })
    const toml = readFileSync(path.join(homeDir, '.gemini', 'commands', 'lib-cmd.toml'), 'utf8')
    assert.match(toml, /description = "测试命令"/)
    assert.ok(toml.includes('{{args}}'))
    assert.ok((await lib('command')).items.some((i) => i.cli === 'gemini' && i.name === 'lib-cmd'))
    await call('DELETE', '/library/file?cli=gemini&kind=command&name=lib-cmd')
    await call('DELETE', '/library/file?cli=claude&kind=skill&name=lib-demo')
    assert.ok(!existsSync(skillDir), '删除 Skill 连文件夹一起删')
    assert.ok(existsSync(path.join(homeDir, '.codex', 'skills', 'lib-demo')), '只删选中的 CLI 里的那一份')
  }
  step('Skills / 命令库：新建、列出、复制给别的 CLI（命令换格式）、删除，名字不能越出目录')

  // MCP 工具：直接读写各 CLI 自己的配置文件，其他配置原样保留
  {
    const codexToml = path.join(homeDir, '.codex', 'config.toml')
    mkdirSync(path.dirname(codexToml), { recursive: true })
    writeFileSync(codexToml, 'model = "gpt-5"\n\n[mcp_servers.old]\ncommand = "old-cmd"\n')
    writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: {} }))
    // 一个最小的 stdio MCP 服务，用来测试「测试连接」
    const mcpJs = path.join(tmp, 'mini-mcp.mjs')
    writeFileSync(
      mcpJs,
      `import readline from 'node:readline'
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'mini' }, capabilities: {} } }))
  if (m.method === 'tools/list') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'hello', description: '打招呼' }] } }))
})`,
    )
    const server = {
      name: 'mini',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpJs],
      env: { A: '1' },
      url: '',
      headers: {},
    }
    const t0 = await call('POST', '/mcp-tools/test', server)
    assert.equal(t0.ok, true, JSON.stringify(t0))
    assert.deepEqual(t0.tools, [{ name: 'hello', description: '打招呼' }])
    assert.equal((await call('POST', '/mcp-tools/test', { ...server, command: 'no-such-cmd-xyz' })).ok, false)
    let ov = await call('GET', '/mcp-tools')
    assert.deepEqual(
      ov.servers.map((x) => [x.name, x.clis]),
      [['old', ['codex']]],
    )
    ov = await call('PUT', '/mcp-tools/mini', { server, clis: ['claude', 'codex', 'gemini'] })
    assert.deepEqual(ov.servers.find((x) => x.name === 'mini').clis, ['claude', 'codex', 'gemini'])
    const cj = JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8'))
    assert.equal(cj.theme, 'dark', 'Claude Code 配置里别的内容保留')
    assert.deepEqual(cj.mcpServers.mini, { type: 'stdio', command: process.execPath, args: [mcpJs], env: { A: '1' } })
    const tomlText = readFileSync(codexToml, 'utf8')
    assert.ok(tomlText.includes('model = "gpt-5"') && tomlText.includes('[mcp_servers.old]'))
    assert.ok(tomlText.includes('[mcp_servers.mini.env]'))
    // 远程地址：Gemini CLI 写 httpUrl，Claude Code 写 type: http
    const remote = {
      name: 'web',
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: 'https://x.example/mcp',
      headers: { A: 'b' },
    }
    await call('PUT', '/mcp-tools/web', { server: remote, clis: ['claude', 'gemini'] })
    const gs = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'settings.json'), 'utf8'))
    assert.equal(gs.mcpServers.web.httpUrl, 'https://x.example/mcp')
    assert.equal(JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8')).mcpServers.web.type, 'http')
    // 只留 Codex：别的 CLI 里的同名工具被移除
    await call('PUT', '/mcp-tools/mini', { server, clis: ['codex'] })
    assert.equal(JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8')).mcpServers.mini, undefined)
    await call('DELETE', '/mcp-tools/mini')
    await call('DELETE', '/mcp-tools/web')
    ov = await call('GET', '/mcp-tools')
    assert.deepEqual(
      ov.servers.map((x) => x.name),
      ['old'],
    )
    assert.ok(readFileSync(codexToml, 'utf8').includes('[mcp_servers.old]'))
    await assert.rejects(call('PUT', '/mcp-tools/bad name', { server: { ...server, name: 'bad name' }, clis: [] }))
  }
  step('MCP 工具：读写 Claude Code / Codex / Gemini CLI 的配置文件，保留其他内容，测试连接能列出工具')

  // Windows 托盘程序（AgentPanel.exe）和服务的约定：启动完成输出地址，托盘关掉输入时服务退出
  {
    const trayPort = port + 1
    const child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['server/index.ts', '--prod'], {
      cwd: root,
      env: {
        ...process.env,
        LANG: 'zh_CN.UTF-8',
        AGENT_PANEL_DATA: dataDir,
        PORT: String(trayPort),
        AGENT_PANEL_TRAY: '1',
        FAKE_CLI_LOG: log,
        // 托盘的「检查更新」：当成发布的包，版本已经是最新的
        AGENT_PANEL_RELEASES_URL: `http://127.0.0.1:${relServer.address().port}/releases`,
        AGENT_PANEL_APP_DIR: path.join(tmp, 'tray-app'),
        AGENT_PANEL_VERSION: '0.11.9-dev',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    // 断言失败时也要把它关掉：它自己不会退，留着会占住事件循环，进程退不出去
    onExit(() => {
      if (child.exitCode === null) child.kill()
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const exited = new Promise((r) => child.on('exit', (code) => r(code)))
    for (let i = 0; i < 100 && !out.includes('AGENT_PANEL_READY'); i++) await sleep(100)
    assert.ok(out.includes(`AGENT_PANEL_READY http://127.0.0.1:${trayPort}/?token=`), '托盘模式输出带令牌的地址')
    const waitOut = async (text) => {
      for (let i = 0; i < 100 && !out.includes(text); i++) await sleep(100)
      assert.ok(out.includes(text), `托盘收到 ${text}`)
    }
    // 点图标：没有打开着的页面时回答 0，托盘去打开新的
    child.stdin.write('focus m1\n')
    await waitOut('AGENT_PANEL_FOCUS m1 0')
    // 有页面开着：页面收到要加到标题上的标记，以及切过来后要打开设置
    const ac = new AbortController()
    const es = await fetch(`http://127.0.0.1:${trayPort}/api/app/events`, { signal: ac.signal })
    const reader = es.body.getReader()
    let sse = ''
    const readSse = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          sse += new TextDecoder().decode(value)
        }
      } catch {}
    })()
    for (let i = 0; i < 50 && !sse.includes('hello'); i++) await sleep(100)
    child.stdin.write('focus m2 settings\n')
    await waitOut('AGENT_PANEL_FOCUS m2 1')
    for (let i = 0; i < 50 && !sse.includes('m2'); i++) await sleep(100)
    assert.match(sse, /event: focus\ndata: \{"type":"focus","mark":"m2","view":"settings"\}/)
    ac.abort()
    await readSse
    // 右键「检查更新」：马上问 GitHub，已经是最新的就告诉托盘
    child.stdin.write('update\n')
    await waitOut('AGENT_PANEL_UPDATE checking')
    await waitOut('AGENT_PANEL_UPDATE latest 已经是最新版本（0.11.9-dev）')
    // 退出时还有 CLI 在跑：要一起停掉，不能留在后台继续改项目
    const n = calls().length
    await fetch(`http://127.0.0.1:${trayPort}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'SLOW 退出时停掉' }),
    })
    for (let i = 0; i < 50 && calls().length === n; i++) await sleep(100)
    const cliPid = calls().at(-1).pid
    child.stdin.end()
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')])
    if (code === 'timeout') child.kill()
    assert.equal(code, 0, '托盘关掉输入后服务退出')
    await sleep(300)
    const alive = (() => {
      try {
        process.kill(cliPid, 0)
        return true
      } catch {
        return false
      }
    })()
    assert.ok(!alive, '服务退出时正在执行的 CLI 也被结束')
  }
  step(
    'Windows 托盘程序：服务启动完成后告诉托盘地址，点图标切到打开着的页面，右键检查更新，托盘退出时服务和正在执行的 CLI 一起退出',
  )

  // 项目分组顺序：默认按添加时间，拖拽后的顺序存进数据文件，重新读出来（刷新、重启）还在
  {
    const names = ['排序A', '排序B', '排序C']
    const created = []
    for (const name of names) {
      // 添加时间只有毫秒精度，逐个创建时中间间隔一下，保证顺序确定
      await sleep(20)
      created.push(
        await call('POST', '/projects', { name, description: '', path: '', categoryId: '', workflowId: wf.id }),
      )
    }
    assert.equal(created[0].childIsolation, 'worktree', '新项目默认子对话用独立 worktree')
    const listOf = async () => (await call('GET', '/projects')).map((p) => p.id)
    const order = (await listOf()).filter((id) => created.some((p) => p.id === id))
    assert.deepEqual(
      order,
      created.map((p) => p.id),
      '默认按添加时间排序，先添加的在前',
    )

    // 重排：拖拽后整个顺序写回，服务端重新编号 1、2、3…
    const all = await listOf()
    const moved = [created[2].id, ...all.filter((id) => id !== created[2].id)]
    const sorted = await call('PUT', '/projects/order', moved)
    assert.deepEqual(
      sorted.map((p) => p.id),
      moved,
      '按请求的顺序返回',
    )
    // 服务端把全部项目从 1 连续编号；这里只看这三个项目的相对顺序和编号是否连续
    const mine = sorted.filter((p) => created.some((c) => c.id === p.id))
    assert.deepEqual(
      mine.map((p) => p.name),
      ['排序C', '排序A', '排序B'],
      '重新编号后相对顺序正确',
    )
    const nums = mine.map((p) => p.sortOrder)
    assert.ok(
      nums.every((n, i) => i === 0 || n > nums[i - 1]),
      `编号按拖拽后的顺序递增：${nums.join(',')}`,
    )
    // 持久化：直接读数据文件，相当于刷新页面或重启服务后再读
    const saved = JSON.parse(readFileSync(path.join(dataDir, 'projects/projects.json'), 'utf8'))
    assert.deepEqual(
      saved
        .filter((p) => created.some((c) => c.id === p.id))
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => p.name),
      ['排序C', '排序A', '排序B'],
      '顺序写进了数据文件',
    )
    assert.deepEqual(await listOf(), moved, '再读一次顺序不变')

    // 校验：重复、不存在、漏掉项目都拒绝，原顺序不变
    const bad = (ids) => assert.rejects(call('PUT', '/projects/order', ids))
    await bad([moved[0], moved[0], ...moved.slice(1)])
    await bad([...moved.slice(0, -1), 'no-such-project'])
    await bad(moved.slice(0, -1))
    assert.deepEqual(await listOf(), moved, '校验失败时不改顺序')

    // 清理，别影响后面的用例
    for (const p of created) await call('DELETE', `/projects/${p.id}`)
  }
  step('项目分组：默认按添加时间排序，拖拽后的顺序持久化，重复 / 不存在 / 漏项的重排请求被拒绝')

  console.log('\n全部通过')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  cleanupAll()
  // 收尾后可能还有句柄拖着事件循环（测试自己起的 fetch 连接池、子进程管道）。
  // unref 的定时器只有在这种情况下才会触发：到点就直接按退出码退出，不再等它们自然关闭
  setTimeout(() => {
    if (process.exitCode) console.error('收尾后还有管道 / 连接没关，按退出码强制退出')
    process.exit(process.exitCode ?? 0)
  }, 2000).unref()
}
