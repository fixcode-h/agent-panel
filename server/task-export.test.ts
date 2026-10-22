import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, Task, defaultAgent } from '../shared/schema.ts'
import { defaultWorkflow } from '../shared/builtin/default.ts'
import {
  analysisPrompt,
  analysisReport,
  cacheHitRate,
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

test('报告：用户要求不截断、失败工具单独统计、改动按节点归属、过程带时间', () => {
  const long = `## 约束\n${'不要动 server/tasks.ts 里的并发逻辑。'.repeat(400)}`
  const withTools = Task.parse({
    ...task,
    changes: [
      { path: 'mine.ts', add: 3, del: 1 },
      { path: 'other-task.ts', add: 90, del: 90 },
    ],
    steps: [
      { ...task.steps[0], changes: [{ path: 'mine.ts', add: 3, del: 1 }] },
      { ...task.steps[0], id: 'other', title: '别人的节点', changes: [{ path: '别人的.ts', add: 90, del: 90 }] },
    ],
    messages: [
      { id: 'u1', role: 'user', text: long, at: '2026-10-19T00:00:00.000Z' },
      { id: 'u2', role: 'user', text: '再补一句', at: '2026-10-19T00:05:00.000Z' },
      {
        id: 'a2',
        role: 'agent',
        agentId: coder.id,
        step: 'handle',
        text: '跑了一下',
        at: '2026-10-19T00:20:00.000Z',
        tools: [
          { kind: 'run', label: 'npm test', output: 'FAIL 3 tests', failed: true },
          { kind: 'read', label: 'a.ts' },
        ],
      },
    ],
  })
  const report = analysisReport([exportTask(withTools, [coder])])
  assert.match(report, /不要动 server\/tasks\.ts 里的并发逻辑/, '用户的要求不截断')
  assert.ok(!report.includes('后面省略'), '要求里没有省略标记')
  assert.match(report, /失败的工具调用 1 次/, '失败的工具调用进统计')
  assert.match(report, /失败详情：[\s\S]*FAIL 3 tests/, '失败工具带输出，能看原因')
  assert.match(report, /\*\*用户\*\*：\d{2}:\d{2}:\d{2} ## 约束/, '用户消息带时间')
  assert.match(report, /\*\*AI（开发）\*\*：\d{2}:\d{2}:\d{2} 跑了一下/, 'AI 回复带时间')
  assert.match(report, /距上一条 15m0s/, '间隔大的单独提示，能看出等待在哪')
  assert.match(report, /追加要求\/对话 0 轮（对话页开着时/, '轮数的口径写清楚')
  assert.match(report, /用户消息 2 条：\d{2}:\d{2}、\d{2}:\d{2}/, '列出每条用户消息的时间')
  assert.match(report, /## 改动的文件（按节点记录）/, '改动按节点列')
  assert.match(report, /### 别人的节点[\s\S]*别人的\.ts/)
  assert.ok(!/## 改动的文件\n/.test(report), '不再用任务级差额冒充本任务的产出')
})

test('按行对比', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc'), [
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'x' },
    { kind: 'same', text: 'c' },
  ])
})

test('缓存命中率：分母是含缓存的输入合计，任何时候都不超过 100%', () => {
  // 正常口径：输入已含缓存
  assert.equal(cacheHitRate({ inputTokens: 1000, cacheReadTokens: 600 }), 0.6)
  // 口径对不上时（历史数据、某个 CLI 把未命中当输入）封顶到 100%，不把 3348% 交给用户
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: 3348 }), 1)
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 500 }), 0)
})
