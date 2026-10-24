import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, Task, defaultAgent } from '../shared/schema.ts'
import { defaultWorkflow } from '../shared/builtin/default.ts'
import {
  analysisPrompt,
  analysisReport,
  cacheHitRate,
  cacheMismatch,
  applyChanges,
  checkExportSize,
  demoEvolution,
  descendantTotals,
  exportTask,
  exportTaskTree,
  importTask,
  importTaskTree,
  lineDiff,
  parseEvolution,
  parseTaskExport,
  redactSecrets,
  resolveChange,
  stripEvolution,
  TASK_EXPORT_MAX_BYTES,
  taskReport,
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

test('统计：子对话（含多层）的成本汇总进 children 和 combined，报告写出两组数', () => {
  const child = Task.parse({
    ...task,
    id: 't2',
    parentTaskId: 't1',
    title: '子对话',
    runMs: 30_000,
    steps: [],
    messages: [
      { id: 'c1', role: 'system', step: '', text: '执行出错：超时', error: true, at },
      {
        id: 'c2',
        role: 'agent',
        agentId: coder.id,
        step: '',
        text: '跑了',
        at,
        tools: [{ kind: 'run', label: 'npm test', failed: true }],
      },
    ],
    usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 1200, costUsd: 0.02 },
  })
  const grand = Task.parse({
    ...child,
    id: 't3',
    parentTaskId: 't2',
    runMs: 5000,
    messages: [],
    usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, costUsd: 0.005 },
  })
  const kids = descendantTotals([child, grand])
  assert.equal(kids.tasks, 2, '两个子对话，不含父对话')
  assert.equal(kids.inputTokens, 2500)
  assert.equal(kids.outputTokens, 500)
  assert.equal(kids.durationMs, 35_000)
  assert.equal(kids.cacheHitRate, 0.48, '命中率按合计重算')
  assert.equal(kids.errors, 2, '报错消息 + 失败的工具调用')
  assert.equal(kids.failedTools, 1)

  const b = exportTask(task, [coder], '', new Date(at), kids)
  const s = b.stats as ReturnType<typeof taskStats>
  assert.equal(s.inputTokens, 1000, '顶层仍是自身')
  assert.equal(s.children.tasks, 2)
  assert.equal(s.combined.tasks, 3)
  assert.equal(s.combined.inputTokens, 3500)
  assert.equal(s.combined.outputTokens, 700)
  assert.equal(s.combined.cacheHitRate, 0.514)

  const report = analysisReport([b])
  assert.match(report, /（自身，不含子对话）/)
  assert.match(report, /子对话 2 个/)
  assert.match(report, /含子对话合计（3 个任务）/)
  assert.match(report, /输入 3\.5k/, '合计不是父对话自己的 1.0k')
  // 旧版本的导出文件里没有 children/combined：只写自身，不报错
  const legacy = { ...b, stats: { ...s, children: undefined, combined: undefined } }
  const old = analysisReport([legacy])
  assert.ok(!old.includes('含子对话合计'), '没有子对话数据时不写合计行')
  assert.ok(!old.includes('（自身，不含子对话）'))
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
  assert.equal(evo.changes.length, 3)
  assert.equal(evo.changes[2].target, 'agent')
  assert.equal(evo.issues[0].files[0], 'shared/engine.ts')
  assert.deepEqual(
    evo.issues.map((x) => [x.scope, x.category]),
    [
      ['panel', '执行引擎'],
      ['project', '商品卡片'],
    ],
  )
  // 旧版建议块只有 framework：照样读成面板框架的问题
  const old = parseEvolution('```workflow-evolution\n{"framework":[{"title":"旧的","detail":"x"}]}\n```')!
  assert.deepEqual(
    old.issues.map((x) => [x.scope, x.category, x.title]),
    [['panel', '', '旧的']],
  )
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

test('节点的最终输出原样导出：保留末尾的 handoff 文件去向，不再二次截断', () => {
  // 引擎已经把输出截到 MAX_OUTPUT，超长部分的全文存在 handoff 文件、去向说明写在输出末尾（见 shared/engine.ts 的 storeOutput）
  const file = 'C:\\Users\\me\\.agent-panel\\handoff\\t1\\n1.md'
  const output = `${'甲'.repeat(4000)}\n\n（完整结果有 9000 字，这里只附了开头。完整内容在文件 ${file}，开始之前请先读完。）`
  const report = analysisReport([exportTask(Task.parse({ ...task, steps: [{ ...task.steps[0], output }] }), [coder])])
  assert.ok(report.includes(`完整内容在文件 ${file}`), '保留 handoff 文件路径，分析时知道去哪读全文')
  assert.ok(!report.includes('后面省略'), '导出不再静默截断')
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
  assert.match(report, /距上一条 15m 0s/, '间隔大的单独提示，能看出等待在哪')
  assert.match(report, /轮次：用户消息 2 条，分成 0 轮执行（这条记录没有分轮信息/, '轮数的口径写清楚')
  assert.match(report, /用户发言时间：\d{2}:\d{2}、\d{2}:\d{2}/, '列出每条用户消息的时间')
  assert.match(report, /## 改动的文件（按节点记录）/, '改动按节点列')
  assert.match(report, /### 别人的节点[\s\S]*别人的\.ts/)
  assert.ok(!/## 改动的文件\n/.test(report), '不再用任务级差额冒充本任务的产出')
})

/** 两轮各执行 10 分钟、中间空了 2 小时 20 分：跨度 2h 40m，执行 20m 0s，空闲 2h 20m */
function twoRounds() {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  return Task.parse({
    ...task,
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T11:40:00.000Z',
    runMs: 20 * 60_000,
    waitMs: 0,
    steps: [],
    messages: [
      { id: 'u1', role: 'user', text: '加个按钮', at: '2026-10-19T09:00:00.000Z' },
      { id: 'u2', role: 'user', text: '再改一下', at: '2026-10-19T11:30:00.000Z' },
    ],
    turns: [
      {
        id: 'r1',
        title: '加个按钮',
        status: 'done',
        startedAt: '2026-10-19T09:00:00.000Z',
        endedAt: '2026-10-19T09:10:00.000Z',
        from,
      },
      {
        id: 'r2',
        title: '再改一下',
        status: 'done',
        startedAt: '2026-10-19T11:30:00.000Z',
        endedAt: '2026-10-19T11:40:00.000Z',
        from,
      },
    ],
  })
}

test('统计：跨度里没有归属的空档算空闲，轮次和用户消息写在一处', () => {
  const rec = twoRounds()
  const s = taskStats(rec)
  assert.equal(s.spanMs, 160 * 60_000, '跨度按记录里的时间戳算：09:00 到 11:40')
  assert.equal(s.durationMs, 20 * 60_000)
  assert.equal(s.idleMs, 140 * 60_000, '两轮之间没有进程在跑的空档算空闲，不再没有归属')
  assert.equal(s.asks, 2, '用户消息条数从记录里数，和轮次分开写')
  assert.equal(s.turns, 2)
  const report = taskReport(exportTask(rec, [coder]))
  assert.match(report, /跨度 2h 40m：执行 20m 0s，等用户 0s，空闲 2h 20m/)
  assert.match(report, /轮次：用户消息 2 条，分成 2 轮执行/)
})

test('旧导出没有跨度和空闲字段：按记录现算，不写 NaN', () => {
  const b = exportTask(twoRounds(), [coder])
  const old = {
    ...b,
    stats: { durationMs: 20 * 60_000, waitMs: 0, turns: 1, turnsUnfinished: 0 },
  } as Parameters<typeof taskReport>[0]
  const report = taskReport(old)
  assert.match(report, /跨度 2h 40m：执行 20m 0s，等用户 0s，空闲 2h 20m/)
  assert.match(report, /轮次：用户消息 2 条，分成 1 轮执行/)
  assert.ok(!report.includes('NaN'), '旧数据不把 NaN 交给用户')
})

test('失败详情：命令用完整原文，带上退出码，没输出时写明', () => {
  const cmd = `git worktree list ${'--porcelain '.repeat(20)}`.trim()
  const label = `${cmd.slice(0, 120)}…`
  const tk = Task.parse({
    ...task,
    messages: [
      {
        id: 'a1',
        role: 'agent',
        agentId: coder.id,
        step: 'handle',
        text: '跑命令',
        at,
        tools: [
          // label 是截断过的一行，input 才是实际执行的完整命令
          { kind: 'run', label, input: cmd, exitCode: 1, output: 'fatal: not a git repository', failed: true },
          // grep 没匹配到：退出码非零但没有任何输出
          { kind: 'run', label: 'grep -r foo src', input: 'grep -r foo src', exitCode: 1, failed: true },
        ],
      },
    ],
  })
  const report = analysisReport([exportTask(tk, [coder])])
  assert.ok(report.includes(cmd), '命令用完整原文，不读被截断的 label')
  assert.match(report, /（退出码 1）\nfatal: not a git repository/, '退出码和输出写在一起')
  assert.match(report, /grep -r foo src（退出码 1）\n（没有输出）/, '没输出时写明，不和退出码非零混在一起')
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

test('缓存命中数超过输入合计时单独标记出来，不让封顶把口径错误藏掉', () => {
  // 常态不提示
  assert.equal(cacheMismatch({ inputTokens: 1000, cacheReadTokens: 600 }), false)
  // 缓存命中是输入的 33 倍（Pi 旧记录里出现过）：这就是分子分母不同口径
  assert.equal(cacheMismatch({ inputTokens: 100, cacheReadTokens: 3348 }), true)
  // 旧记录里那组真实数据：842.3k 输入、74685.2k 缓存命中，88 倍
  assert.equal(cacheMismatch({ inputTokens: 842_300, cacheReadTokens: 74_685_200 }), true)
  // 没有输入时无法判断口径，不提示
  assert.equal(cacheMismatch({ inputTokens: 0, cacheReadTokens: 500 }), false)
})

/** 父对话、子对话、孙对话三层：父对话里还有一个自己派出的子任务（slot: sub） */
function tree() {
  const reviewer = Agent.parse({ id: 'a2', name: '评审', instructions: '评审改动', createdAt: at, updatedAt: at })
  const root = Task.parse({
    ...task,
    id: 'r1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    steps: [
      { id: 'sub1', title: '并行子任务', slot: 'sub', agentId: coder.id, status: 'done', startedAt: at, endedAt: at },
    ],
    messages: [
      { id: 'u1', role: 'user', text: '派两个子任务', at },
      { id: 'a1', role: 'agent', agentId: coder.id, step: 'sub1', text: '派出了', spawned: ['sub1'], at },
    ],
  })
  const child = Task.parse({
    ...root,
    id: 'c1',
    parentTaskId: 'r1',
    rootTaskId: 'r1',
    title: '子对话',
    steps: [],
    messages: [{ id: 'cu1', role: 'user', text: '看一下这个模块', at }],
  })
  const grand = Task.parse({
    ...child,
    id: 'g1',
    parentTaskId: 'c1',
    title: '孙对话',
    messages: [
      { id: 'gu1', role: 'user', text: '孙对话的要求', at },
      { id: 'ga1', role: 'agent', agentId: reviewer.id, step: '', text: '评审完了', at },
    ],
  })
  return { root, child, grand, reviewer }
}

test('导出父对话：子对话（含多层）平铺进包里，子任务和用到的 Agent 一起带走', () => {
  const { root, child, grand, reviewer } = tree()
  const b = exportTaskTree(root, [root, child, grand], [coder, reviewer], '0.30.0', new Date(at))

  assert.equal(b.format, 'agent-panel/task')
  assert.equal(b.children.length, 2, '两个子对话都收进来了')
  // 直接挂在父任务下的写成空：父任务的 id 不进包（导入时重新分配），指向它没法还原
  assert.deepEqual(
    b.children.map((c) => [c.id, c.parentTaskId, c.title]),
    [
      ['c1', '', '子对话'],
      ['g1', 'c1', '孙对话'],
    ],
    '孙对话靠 parentTaskId 指回子对话',
  )
  assert.equal(b.children[1].messages.length, 2, '子对话自己的消息也在包里')
  // 子任务本来就在父任务的步骤里，引用的是 step id，不受子对话 id 重分配影响
  assert.deepEqual(
    b.task.steps.map((s) => [s.id, s.slot]),
    [['sub1', 'sub']],
  )
  assert.deepEqual(b.task.messages.find((m) => m.id === 'a1')?.spawned, ['sub1'])
  assert.deepEqual(b.agents.map((a) => a.id).sort(), [coder.id, reviewer.id].sort(), '子对话用到的角色也带上')
  // 子对话的统计合进 children，报告里能看到整棵树的成本
  const s = b.stats as ReturnType<typeof taskStats>
  assert.equal(s.children.tasks, 2)
  assert.equal(s.combined.tasks, 3)
  // 导出不改原任务
  assert.equal(child.parentTaskId, 'r1')
})

test('导入父对话：还原成同样的父子结构，子对话和子任务的引用都对得上', () => {
  const { root, child, grand, reviewer } = tree()
  const b = parseTaskExport(JSON.parse(JSON.stringify(exportTaskTree(root, [root, child, grand], [coder, reviewer]))))
  const made = importTaskTree(b, 'p2', ['n1', 'n2', 'n3'], at)
  assert.equal(made.length, 3, '父任务和两个子对话都建了')
  const [father, ...kids] = made
  const son = kids.find((x) => x.title === '子对话')!
  const grandson = kids.find((x) => x.title === '孙对话')!

  assert.equal(father.id, 'n1')
  assert.equal(father.parentTaskId, '', '导入的父任务是顶层任务，不会因为 parentTaskId 被列表过滤掉')
  assert.equal(son.parentTaskId, 'n1', '子对话挂在本机新分配的父亲 id 下')
  assert.equal(son.rootTaskId, 'n1')
  assert.equal(grandson.parentTaskId, son.id, '孙对话挂在子对话的新 id 下')
  assert.equal(grandson.rootTaskId, 'n1')
  assert.ok(
    made.every((x) => !!x.imported),
    '导入的任务都是只读的',
  )
  assert.equal(grandson.imported?.agents.length, 2, '两个角色都随任务带进来')
  // 子任务、消息里的引用原样保留
  assert.deepEqual(
    father.steps.map((s) => s.id),
    ['sub1'],
  )
  assert.deepEqual(father.messages.find((m) => m.id === 'a1')?.spawned, ['sub1'])
  // 血缘关系改完仍是合法任务
  assert.equal(Task.parse(grandson).parentTaskId, son.id)
  assert.equal(son.messages[0].text, '看一下这个模块')
})

test('导入边界：同一个子对话在包里出现两次只收一次，父对话不在包里的挂到父任务下', () => {
  const { root, child, grand } = tree()
  const b = exportTaskTree(root, [root, child, grand], [coder])
  const orphan = { ...b.children[0], id: 'gone-child', title: '父对话被删的子对话', parentTaskId: 'deleted-parent' }
  const made = importTaskTree({ ...b, children: [b.children[0], b.children[0], orphan] }, 'p2', ['n1', 'n2', 'n3'], at)
  assert.equal(made.length, 3, '重复的那条只导入一次')
  assert.equal(made[1].title, '子对话')
  assert.equal(made[2].title, '父对话被删的子对话')
  assert.equal(made[2].parentTaskId, 'n1', '父不在包里时挂到导出的父任务下，不会变成看不见的孤儿')
  assert.ok(new Set(made.map((x) => x.id)).size === 3, 'id 没有重复')
})

test('导出同一棵树两次结果一致，体积超过上限时拒绝生成文件', () => {
  const { root, child, grand } = tree()
  const a = exportTaskTree(root, [root, child, grand], [coder], '0.30.0', new Date(at))
  const b = exportTaskTree(root, [root, child, grand], [coder], '0.30.0', new Date(at))
  assert.deepEqual(a, b, '重复导出不影响内容')
  assert.ok(checkExportSize(a) > 0, '正常包给出体积')

  const big = exportTaskTree(root, [root, child, grand], [coder], '0.30.0', new Date(at))
  big.task.messages[0].text = 'x'.repeat(TASK_EXPORT_MAX_BYTES + 1024)
  assert.throws(() => checkExportSize(big), /上限/, '超过上限时不生成一个打不开的文件')
})
