/**
 * 端到端测试：用临时数据目录启动服务，把三个 CLI 都指向 scripts/fake-cli/fake-cli.mjs，
 * 走一遍设置 → 检测 → 工作流任务（含并行阶段）→ 追加要求（续接会话）→ 对话任务 → 停止 → 失败 → 找不到命令 → 停用。
 *
 * 运行：npm run test:e2e（需要 git；假 CLI 依赖 shebang，只能在 macOS / Linux 上跑）
 */
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fake = path.join(root, 'scripts/fake-cli/fake-cli.mjs')
const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-e2e-'))
const dataDir = path.join(tmp, 'data')
const projectDir = path.join(tmp, 'project')
const log = path.join(tmp, 'calls.jsonl')
const port = 8900 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}/api`

// 项目目录：一个已有提交、并且有一处未提交改动的 git 仓库
execFileSync('mkdir', ['-p', projectDir])
const git = (...a) => execFileSync('git', a, { cwd: projectDir, stdio: 'pipe' })
git('init', '-q')
writeFileSync(path.join(projectDir, 'README.md'), '# demo\n')
writeFileSync(path.join(projectDir, 'pre.txt'), 'old\n')
git('add', '.')
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
writeFileSync(path.join(projectDir, 'pre.txt'), 'changed before the task\n')

// 假的 GitHub Releases：三个版本，包是现做的 tar.gz，用来测试设置里的版本更新
const appDir = path.join(tmp, 'app')
const relDir = path.join(tmp, 'releases')
execFileSync('mkdir', ['-p', path.join(appDir, 'dist'), path.join(appDir, 'data'), relDir])
writeFileSync(path.join(appDir, 'server.mjs'), '// old\n')
writeFileSync(path.join(appDir, 'dist/old.html'), 'old')
writeFileSync(path.join(appDir, 'data/keep.json'), '{"keep":true}')
// Windows 托盘程序：上次更新挪开的 AgentPanel.exe.old 还在运行，删不掉也不能被覆盖（这里用非空目录模拟）
writeFileSync(path.join(appDir, 'AgentPanel.exe'), 'tray-old')
execFileSync('mkdir', ['-p', path.join(appDir, 'AgentPanel.exe.old')])
writeFileSync(path.join(appDir, 'AgentPanel.exe.old', 'busy'), '')
for (const v of ['0.11.9-dev', '0.11.8', '0.11.4']) {
  const d = path.join(relDir, `agent-panel-${v}`)
  execFileSync('mkdir', ['-p', path.join(d, 'dist')])
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
execFileSync('mkdir', ['-p', dataDir])
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
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const stop = () => {
  server.kill()
  relServer.close()
}
process.on('exit', stop)

const call = async (method, url, body) => {
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
const step = (name) => console.log(`✓ ${name}`)

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
    clis: { claude: cli({ defaultModel: 'sonnet' }), codex: cli(), commandcode: cli() },
  }
  await call('PUT', '/settings', settings)
  const clis = await call('GET', '/clis?refresh=1')
  assert.deepEqual(
    clis.map((c) => [c.id, c.installed]),
    [
      ['claude', true],
      ['codex', true],
      ['commandcode', true],
    ],
  )
  assert.match(clis[1].version, /fake 0.0.1/)
  step('设置保存，三个 CLI 都能检测到')

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
  const changed = t.changes.map((c) => c.path).sort()
  assert.deepEqual(changed, ['claude-output.txt', 'codex-output.txt', 'commandcode-output.txt'])
  assert.equal(t.changes.find((c) => c.path === 'codex-output.txt').add, 3)
  assert.deepEqual(Object.keys(t.sessions).sort(), ['n1', 'n2', 'n3', 'n4'], '每个节点各有自己的会话')
  assert.equal(Object.keys(t.usage.agents).length, 3)
  assert.equal(t.usage.agents[A.id].context, 13020)
  assert.ok(Math.abs(t.usage.costUsd - 0.0246) < 1e-9)
  // 用量：输入含缓存，缓存命中单独记；流式过程中计入的和最后的总数不重复
  // Claude 两个节点各 25530 输入（25000 命中、500 写入），Codex 24000（20000 命中），Command Code 9000（1000 命中）
  assert.equal(t.usage.inputTokens, 25530 * 2 + 24000 + 9000)
  assert.equal(t.usage.cacheReadTokens, 25000 * 2 + 20000 + 1000)
  assert.equal(t.usage.cacheWriteTokens, 500 * 2)
  assert.equal(t.usage.outputTokens, 120 * 2 + 300 + 80)
  assert.equal(t.usage.agents[B.id].window, 258400, 'Codex 报告的上下文窗口')
  assert.equal(t.usage.agents[A.id].window, 500000, 'Claude Code 在 result.modelUsage 里报告的上下文窗口')
  assert.equal(t.usage.agents[B.id].context, 24300)
  // 每个节点自己的用量和改动：加起来等于任务的；Codex 节点只算它自己写的文件
  assert.equal(
    t.steps.reduce((n, s) => n + (s.usage?.inputTokens ?? 0), 0),
    t.usage.inputTokens,
  )
  const codexStep = t.steps.find((s) => s.agentId === B.id)
  assert.equal(codexStep.usage.context, 24300)
  assert.equal(codexStep.usage.window, 258400)
  assert.deepEqual(codexStep.changes, [{ path: 'codex-output.txt', add: 3, del: 0 }])
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
  assert.ok(t.messages.some((m) => m.agentId === B.id && m.thinking?.includes('先看目录')))
  // 待办：Claude 的 TodoWrite 和 Codex 的计划
  assert.deepEqual(
    t.todos.filter((x) => x.agentId === B.id).map((x) => [x.text, x.status]),
    [
      ['看目录', 'done'],
      ['写文件', 'running'],
    ],
  )
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
  const c2 = [cp1, cp2].find((x) => x.kind === 'codex')
  const c3 = [cp1, cp2].find((x) => x.kind === 'commandcode')
  assert.ok(c2 && c3, '开发阶段应该调用 Codex 和 Command Code')
  assert.ok(c2.start < c3.end && c3.start < c2.end, '同一阶段的两个节点应该同时运行')
  assert.ok(Math.min(c2.start, c3.start) >= c1.end, '下游节点要等上游结束')
  assert.ok(c4.start >= Math.max(c2.end, c3.end), '有两个上游的节点要等两个都结束')
  assert.equal(c2.developer, '你是乙，负责实现。', 'Codex 的角色说明通过 developerInstructions 传入')
  assert.ok(!c2.input.includes('## 你的角色'))
  assert.match(c2.input, /上游节点的结果[\s\S]*### 分析/)
  assert.match(c2.input, /同时进行的节点[\s\S]*文档（丙）/)
  assert.match(c3.input, /同时进行的节点[\s\S]*实现（乙）/)
  assert.equal(c2.args[0], 'app-server', 'Codex 用 app-server 执行才有流式输出')
  assert.ok(c2.args.includes('model="gpt-5.6"'))
  assert.ok(c2.args.includes('approval_policy="on-request"'), '参数里的确认方式和 thread/start 一致')
  assert.deepEqual(
    [c2.approval, c2.sandbox],
    ['on-request', 'workspace-write'],
    '可写项目目录：沙箱内运行，越过沙箱时确认',
  )
  assert.ok(c3.args.includes('--effort') && c3.args.includes('low'))
  assert.equal(c4.kind, 'claude')
  assert.match(c4.input, /上游节点的结果[\s\S]*### 实现[\s\S]*### 文档/)
  assert.ok(!c4.args.includes('--resume'), '不同节点用各自的新会话')
  step('调用参数：模型、权限、角色设定、上游结果、同时进行的节点、工作目录都对；没有依赖的节点同时运行')

  // 上游的结果太长：交给下游的只放开头，完整内容存成文件，下游的 CLI 能读到那个目录
  const nLong = calls().length
  let tLong = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'LONGOUT 写个详细方案' })
  tLong = await waitDone(tLong.id)
  assert.equal(tLong.status, 'done')
  const down = calls()
    .slice(nLong)
    .find((x) => x.kind === 'codex')
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
  assert.equal(calls().at(-1).input, '解释一下项目结构')
  await call('POST', `/tasks/${chat.id}/messages`, { text: '继续' })
  chat = await waitDone(chat.id)
  c = calls().at(-1)
  assert.ok(c.args.includes('--resume') && c.args.includes(chat.sessions[C.id]))
  step('对话任务：直接发给选中的 Agent，继续对话会续接会话')

  // ---- 自带的默认 Agent ----
  const allAgents = await call('GET', '/agents')
  const def = allAgents.find((x) => x.id === 'default-agent')
  assert.ok(def && def.cli === '' && def.model === '', '自带默认 Agent，跟随默认 CLI 的默认模型')
  assert.equal(
    (await fetch(`${base}/agents/default-agent`, { method: 'DELETE', headers: { 'content-type': 'application/json' } }))
      .status,
    409,
    '默认 Agent 不能删除',
  )
  const renamed = await call('PUT', '/agents/default-agent', { ...def, name: '助手', cli: 'codex', model: '@high' })
  assert.deepEqual(
    [renamed.name, renamed.cli, renamed.model],
    ['助手', '', ''],
    '默认 Agent 只能改名称这些，模型固定跟随默认',
  )
  await call('PUT', '/agents/default-agent', def)
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
  let free = await call('POST', '/tasks', { mode: 'chat', agentId: 'default-agent', prompt: '随便聊聊' })
  assert.equal(free.projectId, '')
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
    '默认 Agent：跟随默认 CLI，不能删除，对话时可以临时换模型和思考强度；任务记录执行时间；Chat 模式的聊天不属于项目',
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

  // ---- 插话：Codex 用 turn/steer、Claude Code 写进 stdin，交给正在跑的这一轮；Command Code 不支持，改成排队 ----
  {
    const steerLog = () => readLog(`${log}.steer`)
    const chatWith = (extra, prompt) =>
      call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: 'default-agent', prompt, ...extra })
    let a = await chatWith({ cli: 'codex' }, 'SLOW 插话 codex')
    let b = await chatWith({ cli: 'claude' }, 'SLOW 插话 claude')
    let q = await chatWith({ cli: 'commandcode' }, 'SLOW 插话 cmd')
    await sleep(1200)
    a = await call('POST', `/tasks/${a.id}/messages`, { text: '顺便看看测试', steer: true })
    b = await call('POST', `/tasks/${b.id}/messages`, { text: '也看看文档', steer: true })
    q = await call('POST', `/tasks/${q.id}/messages`, { text: '排队吧', steer: true })
    assert.equal(a.queue.length, 0, '插话不排队')
    assert.ok(
      a.messages.some((m) => m.role === 'user' && m.text === '顺便看看测试'),
      '插话的内容马上出现在对话里',
    )
    assert.deepEqual(
      q.queue.map((x) => x.text),
      ['排队吧'],
      '不支持插话的 CLI 改成排队',
    )
    await call('DELETE', `/tasks/${q.id}/queue/${q.queue[0].id}`)
    a = await waitDone(a.id)
    b = await waitDone(b.id)
    await waitDone(q.id)
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
    const at = a.messages.findIndex((m) => m.text === '顺便看看测试')
    assert.ok(
      a.messages.slice(at + 1).some((m) => m.role === 'agent' && m.text.includes('codex 的回复')),
      '插话之后的输出排在插话后面',
    )
    // 命令的输出边跑边显示，完成后不再是执行中
    const run = a.messages.flatMap((m) => m.tools).find((x) => x.kind === 'run')
    assert.equal(run.output, 'total 8\nREADME.md\n')
    assert.ok(!run.running)
    step('插话：Codex、Claude Code 交给正在跑的这一轮，Command Code 改成排队；命令输出边跑边显示')

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
    assert.ok(a.messages.some((m) => m.role === 'system' && m.text === '已压缩上下文'))
    await call('POST', `/tasks/${b.id}/compact`)
    b = await waitDone(b.id)
    assert.equal(calls().at(-1).input, '/compact', 'Claude Code 用 /compact')
    assert.ok(b.messages.some((m) => m.role === 'system' && m.text === '已压缩上下文'))
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

  // ---- 执行中发消息：默认排队，这一轮完成后接着处理；可以撤回；打断时停下当前这一轮马上处理 ----
  {
    let q = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      prompt: 'SLOW 排队测试',
    })
    await sleep(300)
    q = await call('POST', `/tasks/${q.id}/messages`, { text: '排队的第一条' })
    q = await call('POST', `/tasks/${q.id}/messages`, { text: '排队的第二条' })
    assert.deepEqual(
      q.queue.map((x) => x.text),
      ['排队的第一条', '排队的第二条'],
    )
    assert.equal(q.status, 'running')
    q = await call('DELETE', `/tasks/${q.id}/queue/${q.queue[1].id}`)
    assert.equal(q.queue.length, 1, '撤回一条')
    // 等两轮都跑完（第一轮慢，第二轮是排队的那条）
    for (let i = 0; i < 100; i++) {
      q = await call('GET', `/tasks/${q.id}`)
      if (q.status !== 'running' && !q.queue.length) break
      await sleep(200)
    }
    assert.equal(q.status, 'done')
    assert.deepEqual(
      q.messages.filter((m) => m.role === 'user').map((m) => m.text),
      ['SLOW 排队测试', '排队的第一条'],
      '排队的要求在这一轮完成后接着处理，撤回的不处理',
    )
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
  step('执行中发消息：默认排队、可以撤回，这一轮完成后接着处理；也可以打断马上处理')

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
  const beforeResume = calls().length
  await call('POST', `/tasks/${half.id}/resume`)
  half = await waitDone(half.id, 20000)
  assert.equal(half.status, 'done', JSON.stringify(half.messages.filter((m) => m.role === 'system')))
  const cont = calls().slice(beforeResume)[0]
  assert.match(cont.input, /从中断的地方接着完成本节点/)
  assert.ok(!half.steps.some((s) => s.interrupted))
  step('中断恢复：停止后继续执行，被打断的节点续接会话接着做')

  // ---- 工作流执行中补充信息：交给正在跑的节点（收不了时留给下一个节点），不排队、不算新要求 ----
  {
    let w = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'SLOW 工作流补充' })
    await sleep(1000)
    const before = calls().length
    w = await call('POST', `/tasks/${w.id}/messages`, { text: '接口要兼容旧版', steer: true })
    assert.equal(w.queue.length, 0, '工作流的补充不排队')
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
      agentId: 'default-agent',
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
  let ask = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'ASK 需要确认' })
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
  await call('POST', `/tasks/${ask.id}/requests/${r2.id}`, { allow: true, answer: 'SQLite' })
  await assert.rejects(call('POST', `/tasks/${ask.id}/requests/${r2.id}`, { allow: true }), /已经结束/)
  ask = await waitDone(ask.id)
  assert.equal(ask.status, 'done')
  assert.equal(ask.requests.length, 0)
  const [a1, a2] = readLog(log + '.ask').at(-1)
  assert.equal(a1.behavior, 'allow')
  assert.equal(a1.updatedInput.command, 'rm -rf build')
  assert.equal(a2.updatedInput.answers['用哪个数据库？'], 'SQLite')
  assert.ok(ask.messages.some((m) => m.role === 'system' && /你允许了：运行命令：rm -rf build/.test(m.text)))
  step('权限请求：命令和问题在任务上等用户确认，回答后交回 CLI')

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
  await call('DELETE', `/tasks/${br.id}`)
  await call('DELETE', `/tasks/${bud.id}`)
  await call('DELETE', `/workflows/${wfBranch.id}`)
  await call('DELETE', `/workflows/${wfBudget.id}`)
  step('工作流：条件连线按结论选路，完成后等我确认（可以退回），超过预算上限暂停')

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
  // 续接前把这次的报错写进对话，不悄悄重试
  const shown = net.messages.find(
    (m) => m.role === 'system' && m.error && /正在自动续接会话重试（第 1\/2 次）/.test(m.text),
  )
  assert.ok(shown && /Unable to connect to the API/.test(shown.text), '断开的报错要显示出来再续接')
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
    ['commandcode', 'codex', 'claude', 'codex', 'claude', 'commandcode', 'claude'],
  )
  assert.match(hc[1].input, /开始流程的结果[\s\S]*的回复/)
  assert.match(hc[2].input, /实现功能」的验收流程（第 1 轮验收）[\s\S]*验收结论/)
  assert.ok(hc[3].resume, '验收不通过后续接节点的会话继续完善')
  assert.match(hc[3].input, /验收没有通过（第 1 轮）[\s\S]*验收结论：不通过/)
  assert.match(hc[4].input, /第 2 轮验收/)
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
    prompt: 'COMMIT 在独立分支上改',
    isolate: true,
  })
  assert.equal(tIso.worktree?.state, 'active', '建了独立分支')
  tIso = await waitDone(tIso.id)
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
  assert.equal(merged.worktree.state, 'merged')
  assert.ok(existsSync(path.join(projectDir, 'committed.txt')), '合并后改动进了项目目录')
  assert.ok(existsSync(path.join(projectDir, 'later.txt')), '没提交的改动合并前先提交')
  assert.equal(
    readFileSync(path.join(projectDir, 'pre.txt'), 'utf8'),
    'changed before the task\n',
    '项目里原有的改动保留',
  )
  assert.ok(!existsSync(tIso.worktree.path), '合并后删掉独立目录')
  assert.equal(git('branch', '--list', tIso.worktree.branch).toString().trim(), '', '合并后删掉任务分支')
  // 退回合并前，免得影响后面的测试（--keep 保留 pre.txt 的未提交改动）
  git('reset', '-q', '--keep', 'HEAD~1')
  writeFileSync(blocker, blockerText)
  let tDrop = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'COMMIT 这个不要了',
    isolate: true,
  })
  tDrop = await waitDone(tDrop.id)
  const dropped = await call('POST', `/tasks/${tDrop.id}/worktree/discard`)
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
    category: '质量',
    instructions: '## 职责\n审查',
  }
  let job = await assist('agent', `要一个审查员\nFAKE_JSON:${JSON.stringify(draftAgent)}`)
  assert.equal(job.status, 'done', job.error)
  assert.equal(job.text, '这是按你的要求生成的配置。')
  assert.equal(job.proposal.agent.cli, 'codex')
  assert.equal(job.proposal.newCategory, '质量', '不存在的分类标记为新建')
  c = calls().at(-1)
  assert.match(c.input, /配置助手[\s\S]*## 已有的 Agent[\s\S]*甲（claude[\s\S]*## 创建规则[\s\S]*## 输出格式/)
  assert.ok(c.args.includes('--permission-mode') ? c.args.includes('default') : true, '只读权限')
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
        ['bg', 'idle', 2, 'cli', 1],
        ['frame', 'idle', 2, 'cli', 1],
      ],
      '每张图生成两版：一版从 savedPath 读，一版从 base64 读',
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
    step('UI 设计：AI 搭控件树（自动修正一次）、Codex 生图、保存、导出成 UMG 的 JSON 和贴图，和任务分开')

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

    // 「控件」列表：项目里别的设计的子控件能连同图片加进来
    const other2 = await call('POST', '/designs', { projectId: uiProject.id, kind: 'game', title: 'Shop' })
    const pc = await call('GET', `/designs/projects/${uiProject.id}/components`)
    const fromMenu = pc.find((x) => x.designId === design.id)
    assert.deepEqual(
      fromMenu.components.map((c) => c.Name),
      ['WBP_MenuButton'],
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
  const cl = await call('GET', '/clis/claude/models')
  assert.equal(cl.source, 'builtin')
  assert.ok(cl.models.some((m) => m.id === 'claude-opus-5-5'))
  assert.ok(!cl.models.some((m) => m.id === 'opus'), '不列别名')
  step('从本机 CLI 读取模型列表：Codex 走 app-server，Command Code 走 --list-models')

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
  await assert.rejects(call('POST', '/clis/nope/install'), /未知的 CLI/)
  // 切走再回来能找到最近一次操作
  assert.deepEqual(
    (await call('GET', '/clis/jobs')).map((j) => [j.cli, j.status]),
    [
      ['claude', 'done'],
      ['codex', 'failed'],
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
    ['commandcode', 'claude', 'codex'],
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
  aj = await installJob('v0.11.9-dev')
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
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const exited = new Promise((r) => child.on('exit', (code) => r(code)))
    for (let i = 0; i < 100 && !out.includes('AGENT_PANEL_READY'); i++) await sleep(100)
    assert.ok(out.includes(`AGENT_PANEL_READY http://127.0.0.1:${trayPort}/?token=`), '托盘模式输出带令牌的地址')
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
  step('Windows 托盘程序：服务启动完成后告诉托盘地址，托盘退出时服务和正在执行的 CLI 一起退出')

  console.log('\n全部通过')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  stop()
}
