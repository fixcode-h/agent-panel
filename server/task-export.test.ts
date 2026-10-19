import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, Task, defaultAgent } from '../shared/schema.ts'
import { defaultWorkflow } from '../shared/builtin/default.ts'
import {
  analysisPrompt,
  analysisReport,
  applyChanges,
  demoEvolution,
  exportTask,
  importTask,
  lineDiff,
  parseEvolution,
  parseTaskExport,
  redactSecrets,
  resolveChange,
  stripEvolution,
  taskStats,
} from '../shared/task-export.ts'

const at = '2026-10-19T00:00:00.000Z'
const coder = Agent.parse({ id: 'a1', name: '开发', instructions: '写代码', createdAt: at, updatedAt: at })
const wf = { ...defaultWorkflow(), id: 'w1', name: '日常开发', mainAgentId: coder.id }
wf.flows[0].nodes[0].agentId = coder.id

const task = Task.parse({
  id: 't1',
  projectId: 'p1',
  title: '加一个按钮',
  mode: 'workflow',
  workflowId: wf.id,
  workflowName: wf.name,
  status: 'done',
  runMs: 90_000,
  sessions: { handle: 'sess-1' },
  command: ['claude', '-p'],
  baseRef: 'abc',
  workflows: [wf],
  steps: [
    {
      id: 'handle',
      title: '处理并推荐',
      agentId: coder.id,
      status: 'done',
      startedAt: at,
      endedAt: '2026-10-19T00:01:00.000Z',
      rounds: 2,
      verdict: 'pass',
      output: '做完了',
      command: ['claude', '--resume', 'sess-1'],
      usage: { inputTokens: 1000, cacheReadTokens: 600, outputTokens: 200, costUsd: 0.01 },
    },
  ],
  messages: [
    { id: 'm1', role: 'user', text: '加个按钮，key 是 sk-ant-abcdefghijklmnopqrstuvwxyz', at },
    {
      id: 'm2',
      role: 'agent',
      agentId: coder.id,
      step: 'handle',
      text: '改好了。export API_KEY=supersecretvalue123',
      attachments: [{ name: 'a.png', path: '/home/me/uploads/a.png', size: 10, mime: 'image/png' }],
      at,
    },
    { id: 'm3', role: 'system', step: 'handle', text: '执行出错：超时', error: true, at },
  ],
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, costUsd: 0.01 },
  createdAt: at,
  updatedAt: at,
})

test('导出：带版本号和统计，去掉会话、命令、项目、附件路径和密钥', () => {
  const b = exportTask(task, [defaultAgent(), coder], '0.26.1', new Date(at))
  assert.equal(b.format, 'agent-panel/task')
  assert.equal(b.version, 1)
  assert.equal(b.app, '0.26.1')
  const raw = JSON.stringify(b)
  assert.ok(!raw.includes('sess-1') && !raw.includes('"p1"') && !raw.includes('/home/me'), raw)
  assert.ok(!raw.includes('sk-ant-abcdef') && !raw.includes('supersecretvalue123'), '密钥去掉了')
  assert.match(raw, /\[已移除\]/)
  assert.deepEqual(
    b.agents.map((a) => a.id),
    [coder.id],
    '只带用到的 Agent',
  )
  const s = b.stats as ReturnType<typeof taskStats>
  assert.equal(s.nodes[0].ms, 60_000)
  assert.equal(s.nodes[0].cacheHitRate, 0.6)
  assert.equal(s.nodes[0].errors, 1)
  assert.equal(s.reworks, 1, '验收两轮算返工一次')
})

test('导入：只读任务，Agent 存在任务里；格式不对、版本太新时给出原因', () => {
  const b = parseTaskExport(JSON.parse(JSON.stringify(exportTask(task, [coder]))))
  const tk = importTask(b, 'p2', 'new-id', at)
  assert.equal(tk.id, 'new-id')
  assert.equal(tk.projectId, 'p2')
  assert.equal(tk.imported?.agents[0].name, '开发')
  assert.deepEqual(tk.sessions, {})
  assert.equal(Task.parse(tk).messages.length, 3)
  assert.throws(() => parseTaskExport({ format: 'agent-panel/workflow' }), /不是 Agent 面板导出的任务/)
  assert.throws(() => parseTaskExport({ ...b, version: 9 }), /更新版本/)
  // 再导出：用导入时带来的 Agent
  assert.equal(exportTask(tk, []).agents[0].id, coder.id)
})

test('去密钥：常见格式都能认出，普通文字不动', () => {
  assert.equal(redactSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz1234'), 'token: [已移除]')
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer [已移除]')
  assert.equal(redactSecrets('password="hunter22"'), 'password="[已移除]"')
  assert.equal(redactSecrets('把 token 数量降下来'), '把 token 数量降下来')
})

test('分析：报告列出统计、工作流定义和过程；要求里列出可以改的对象，长度在输入上限内', () => {
  const b = exportTask(task, [coder])
  const report = analysisReport([b])
  assert.match(report, /缓存命中 600，60%/)
  assert.match(report, /node id: handle/)
  assert.match(report, /执行出错：超时/)
  const prompt = analysisPrompt([b], '为什么慢')
  assert.match(prompt, /workflowId: w1｜日常开发/)
  assert.match(prompt, /flowId: main, nodeId: handle/)
  assert.match(prompt, /agentId: a1｜开发/)
  assert.match(prompt, /用户特别关心：为什么慢/)
  assert.ok(prompt.length < 20000)
})

test('修改建议：解析、对比、应用；不合法的值和找不到的对象标出来，不会应用', () => {
  const text = `分析完了。\n\n${demoEvolution(analysisPrompt([exportTask(task, [coder])]))}`
  assert.equal(stripEvolution(text), '分析完了。')
  const evo = parseEvolution(text)!
  assert.equal(evo.changes.length, 2)
  assert.equal(evo.framework[0].files[0], 'shared/engine.ts')
  const rows = evo.changes.map((c) => resolveChange(c, [wf], [coder]))
  assert.ok(rows.every((r) => !r.error))
  assert.equal(rows[1].before, 'high')
  assert.equal(rows[1].after, 'medium')

  const bad = parseEvolution(
    '```workflow-evolution\n' +
      JSON.stringify({
        changes: [
          { target: 'node', workflowId: 'w1', nodeId: 'handle', field: 'retries', value: 9 },
          { target: 'node', workflowId: 'w1', nodeId: 'nope', field: 'title', value: 'x' },
          { target: 'agent', agentId: 'a1', field: 'instructions', value: '更清楚的设定' },
          { target: 'whatever' },
        ],
      }) +
      '\n```',
  )!
  assert.equal(bad.changes.length, 3, '不认识的条目跳过')
  const [r0, r1] = bad.changes.map((c) => resolveChange(c, [wf], [coder]))
  assert.match(r0.error ?? '', /0 到 5/)
  assert.match(r1.error ?? '', /没有这个节点/)

  const out = applyChanges([...evo.changes, ...bad.changes], [wf], [coder])
  assert.equal(out.workflows.length, 1)
  const node = out.workflows[0].flows[0].nodes[0]
  assert.equal(node.tier, 'medium')
  assert.match(out.workflows[0].description, /先确认范围/)
  assert.equal(node.retries, wf.flows[0].nodes[0].retries, '不合法的重试次数没应用')
  assert.equal(out.agents[0].instructions, '更清楚的设定')
  assert.equal(wf.flows[0].nodes[0].tier, 'high', '原来的工作流不动')
})

test('按行对比', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc'), [
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'x' },
    { kind: 'same', text: 'c' },
  ])
})
