/**
 * 端到端测试：用临时数据目录启动服务，把三个 CLI 都指向 scripts/fake-cli/fake-cli.mjs，
 * 走一遍设置 → 检测 → 工作流任务 → 追加要求（续接会话）→ 对话任务 → 停止 → 失败 → 找不到命令 → 停用。
 *
 * 运行：npm run test:e2e（需要 git；假 CLI 依赖 shebang，只能在 macOS / Linux 上跑）
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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

const server = spawn(path.join(root, 'node_modules/.bin/tsx'), ['server/index.ts'], {
  cwd: root,
  env: { ...process.env, AGENT_PANEL_DATA: dataDir, PORT: String(port), FAKE_CLI_LOG: log },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const stop = () => server.kill()
process.on('exit', stop)

const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
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
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
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
  const cli = (extra = {}) => ({ enabled: true, command: fake, defaultModel: '', permission: '', extraArgs: [], env: [{ key: 'FOO', value: 'bar' }], ...extra })
  const settings = { execution: 'real', stepTimeoutMinutes: 5, clis: { claude: cli({ defaultModel: 'sonnet' }), codex: cli(), commandcode: cli() } }
  await call('PUT', '/settings', settings)
  const clis = await call('GET', '/clis?refresh=1')
  assert.deepEqual(clis.map((c) => [c.id, c.installed]), [['claude', true], ['codex', true], ['commandcode', true]])
  assert.match(clis[1].version, /fake 0.0.1/)
  step('设置保存，三个 CLI 都能检测到')

  const agent = (o) => call('POST', '/agents', { description: '', model: '', icon: 'bot', categoryId: '', instructions: '', extraArgs: [], enabled: true, ...o })
  const A = await agent({ name: '甲', cli: 'claude', instructions: '你是甲，负责规划。' })
  const B = await agent({ name: '乙', cli: 'codex', model: 'gpt-5.6', instructions: '你是乙，负责实现。' })
  const C = await agent({ name: '丙', cli: 'commandcode', extraArgs: ['--effort', 'low'] })
  const wf = await call('POST', '/workflows', {
    name: '三步',
    description: '',
    mainAgentId: A.id,
    members: [{ agentId: B.id, responsibility: '' }, { agentId: C.id, responsibility: '' }],
    document: '# 目标\n测试\n\n## 1. 分析 @甲\n先分析。\n\n## 2. 实现 @乙\n写代码。\n\n## 3. 收尾 @丙\n整理。\n',
  })
  const project = await call('POST', '/projects', { name: '测试项目', description: '', path: projectDir, categoryId: '', workflowId: wf.id })

  // ---- 工作流任务 ----
  let t = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '做一个新功能' })
  assert.equal(t.status, 'running')
  t = await waitDone(t.id)
  assert.equal(t.status, 'done', JSON.stringify(t.messages.filter((m) => m.role === 'system')))
  assert.equal(t.simulated, false)
  assert.deepEqual(t.steps.map((s) => s.status), ['done', 'done', 'done'])
  assert.deepEqual(t.steps.map((s) => s.title), ['分析', '实现', '收尾'])
  for (const who of [A, B, C]) assert.ok(t.messages.some((m) => m.agentId === who.id && m.text.includes('的回复')), `${who.name} 没有输出文字`)
  const kinds = new Set(t.messages.flatMap((m) => m.tools.map((x) => x.kind)))
  for (const k of ['read', 'edit', 'run']) assert.ok(kinds.has(k), `缺少工具类型 ${k}`)
  const changed = t.changes.map((c) => c.path).sort()
  assert.deepEqual(changed, ['claude-output.txt', 'codex-output.txt', 'commandcode-output.txt'])
  assert.equal(t.changes.find((c) => c.path === 'codex-output.txt').add, 3)
  assert.equal(Object.keys(t.sessions).length, 3)
  assert.equal(Object.keys(t.usage.agents).length, 3)
  assert.equal(t.usage.agents[A.id].context, 13020)
  assert.ok(Math.abs(t.usage.costUsd - 0.0123) < 1e-9)
  step('工作流任务：三步依次调用三个 CLI，输出、工具、改动（排除任务前的改动）、用量都正确')

  let c = calls()
  const [c1, c2, c3] = c
  assert.equal(c1.kind, 'claude')
  assert.equal(c1.cwd, projectDir)
  assert.ok(c1.args.includes('--append-system-prompt') && c1.args.includes('你是甲，负责规划。'))
  assert.ok(c1.args.includes('--model') && c1.args.includes('sonnet'), 'Agent 没写模型时应使用设置里的默认模型')
  assert.ok(c1.args.includes('--permission-mode') && c1.args.includes('acceptEdits'))
  assert.match(c1.input, /第 1\/3 步：分析/)
  assert.equal(c2.kind, 'codex')
  assert.ok(c2.input.startsWith('## 你的角色\n你是乙'), 'Codex 不支持系统提示参数，角色应拼进任务描述')
  assert.match(c2.input, /之前步骤的结果[\s\S]*甲/)
  assert.ok(c2.args.includes('-m') && c2.args.includes('gpt-5.6'))
  assert.equal(c2.args.at(-1), '-')
  assert.equal(c3.kind, 'commandcode')
  assert.ok(c3.args.includes('--effort') && c3.args.includes('low'))
  step('调用参数：模型、权限、角色设定、前序结果、工作目录都传对了')

  // ---- 追加要求：主 Agent 续接会话 ----
  await call('POST', `/tasks/${t.id}/messages`, { text: '按钮改成红色' })
  t = await waitDone(t.id)
  assert.equal(t.status, 'done')
  c = calls().at(-1)
  assert.equal(c.kind, 'claude')
  assert.ok(c.args.includes('--resume') && c.args.includes(t.sessions[A.id]), '追加要求应该续接主 Agent 的会话')
  assert.match(c.input, /按钮改成红色/)
  step('追加要求：由主 Agent 续接会话处理')

  // ---- 对话任务 ----
  let chat = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: C.id, prompt: '解释一下项目结构' })
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

  // ---- 失败 ----
  let bad = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'FAIL 请失败' })
  bad = await waitDone(bad.id)
  assert.equal(bad.status, 'failed')
  assert.match(bad.messages.at(-1).text, /Claude Code 执行失败[\s\S]*模拟的失败/)
  let badWf = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'FAIL 工作流' })
  badWf = await waitDone(badWf.id)
  assert.equal(badWf.status, 'failed')
  assert.deepEqual(badWf.steps.map((s) => s.status), ['failed', 'pending', 'pending'])
  step('失败：显示 CLI 报告的错误，工作流停在失败的步骤')

  // ---- 找不到命令 / 停用 ----
  await call('PUT', '/settings', { ...settings, clis: { ...settings.clis, commandcode: cli({ command: path.join(tmp, 'nope', 'cmdc') }), codex: cli({ enabled: false }) } })
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

  // ---- 模拟执行 ----
  await call('PUT', '/settings', { ...settings, execution: 'simulate' })
  let sim = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: '模拟一下' })
  const before = calls().length
  sim = await waitDone(sim.id)
  assert.equal(sim.status, 'done')
  assert.equal(sim.simulated, true)
  assert.equal(calls().length, before, '模拟执行不应调用 CLI')
  step('模拟执行：不调用 CLI')

  console.log('\n全部通过')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  stop()
}
