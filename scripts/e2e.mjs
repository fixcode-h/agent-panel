/**
 * 端到端测试：用临时数据目录启动服务，把三个 CLI 都指向 scripts/fake-cli/fake-cli.mjs，
 * 走一遍设置 → 检测 → 工作流任务（含并行阶段）→ 追加要求（续接会话）→ 对话任务 → 停止 → 失败 → 找不到命令 → 停用。
 *
 * 运行：npm run test:e2e（需要 git；假 CLI 依赖 shebang，只能在 macOS / Linux 上跑）
 */
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
for (const v of ['0.11.9-dev', '0.11.8', '0.11.4']) {
  const d = path.join(relDir, `agent-panel-${v}`)
  execFileSync('mkdir', ['-p', path.join(d, 'dist')])
  writeFileSync(path.join(d, 'server.mjs'), `// new ${v}\n`)
  writeFileSync(path.join(d, 'dist/index.html'), `<p>${v}</p>`)
  writeFileSync(path.join(d, 'start.sh'), '#!/bin/sh\n')
  execFileSync('tar', ['-czf', `${d}.tar.gz`, `agent-panel-${v}`], { cwd: relDir })
}
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
    PORT: String(port),
    FAKE_CLI_LOG: log,
    AGENT_PANEL_NPM: path.join(root, 'scripts/fake-cli/fake-npm.mjs'),
    AGENT_PANEL_RELEASES_URL: `http://127.0.0.1:${relServer.address().port}/releases`,
    AGENT_PANEL_APP_DIR: appDir,
    AGENT_PANEL_VERSION: '0.11.5',
    AGENT_PANEL_NO_RESTART: '1',
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
  assert.ok(c2.args.includes('approval_policy="never"'))
  assert.ok(c3.args.includes('--effort') && c3.args.includes('low'))
  assert.equal(c4.kind, 'claude')
  assert.match(c4.input, /上游节点的结果[\s\S]*### 实现[\s\S]*### 文档/)
  assert.ok(!c4.args.includes('--resume'), '不同节点用各自的新会话')
  step('调用参数：模型、权限、角色设定、上游结果、同时进行的节点、工作目录都对；没有依赖的节点同时运行')

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

  // ---- 停止 ----
  let slow = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'SLOW 慢慢来' })
  await sleep(800)
  const t0 = Date.now()
  await call('POST', `/tasks/${slow.id}/stop`)
  slow = await waitDone(slow.id, 8000)
  assert.equal(slow.status, 'stopped')
  assert.ok(Date.now() - t0 < 5000, '停止应该很快生效')
  step('停止：进程被结束，任务标记为已停止')

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
  step('失败：显示 CLI 报告的错误，工作流停在失败的节点')

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
  assert.match(h2.messages.at(-1).text, /验收 1 轮仍未通过/)
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
  step('附件：上传到数据目录、交给 Agent 读取；@ 能搜到项目里的文件')
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
  assert.match(missing.messages.at(-1).text, /找不到命令[\s\S]*npm install -g command-code/)
  let disabled = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'hi' })
  disabled = await waitDone(disabled.id)
  assert.equal(disabled.status, 'failed')
  assert.match(disabled.messages.at(-1).text, /停用/)
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
  step('目录浏览列出主目录和磁盘')

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
  let aj = await call('POST', '/app/install', { tag: 'v0.11.9-dev' })
  for (let i = 0; aj.status === 'running' && i < 100; i++) {
    await sleep(100)
    aj = await call('GET', `/app/install/${aj.id}`)
  }
  assert.equal(aj.status, 'done', aj.error)
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// new 0.11.9-dev\n')
  assert.ok(existsSync(path.join(appDir, 'dist/index.html')) && !existsSync(path.join(appDir, 'dist/old.html')))
  assert.equal(readFileSync(path.join(appDir, 'data/keep.json'), 'utf8'), '{"keep":true}', '数据不能动')
  assert.ok(!existsSync(path.join(appDir, 'dist.old')) && !existsSync(path.join(appDir, 'dist.next')))
  step('版本更新：读取 GitHub 上的包、判断有没有新版本，下载切换后替换程序文件、保留数据')

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

  // Windows 托盘程序（AgentPanel.exe）和服务的约定：启动完成输出地址，托盘关掉输入时服务退出
  {
    const trayPort = port + 1
    const child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['server/index.ts', '--prod'], {
      cwd: root,
      env: { ...process.env, AGENT_PANEL_DATA: dataDir, PORT: String(trayPort), AGENT_PANEL_TRAY: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const exited = new Promise((r) => child.on('exit', (code) => r(code)))
    for (let i = 0; i < 100 && !out.includes('AGENT_PANEL_READY'); i++) await sleep(100)
    assert.ok(out.includes(`AGENT_PANEL_READY http://127.0.0.1:${trayPort}`), '托盘模式输出地址')
    child.stdin.end()
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')])
    if (code === 'timeout') child.kill()
    assert.equal(code, 0, '托盘关掉输入后服务退出')
  }
  step('Windows 托盘程序：服务启动完成后告诉托盘地址，托盘退出时服务跟着退出')

  console.log('\n全部通过')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  stop()
}
