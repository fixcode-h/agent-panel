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
  NO_TOTALS,
  parseEvolution,
  parseTaskExport,
  redactSecrets,
  resolveChange,
  stripEvolution,
  TASK_EXPORT_MAX_BYTES,
  taskReport,
  taskHtml,
  taskStats,
} from '../shared/task-export.ts'
import { endRun, pauseRun, resumeRun } from '../shared/task.ts'

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
    { id: 'm1', role: 'user', text: '加个按钮，key 是 sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx', at },
    {
      id: 'm2',
      role: 'agent',
      agentId: coder.id,
      step: 'handle',
      text: '改好了。export API_KEY=xxxxxxxxxxxxxxxxxxxx',
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
  assert.ok(!raw.includes('sk-ant-xxxx') && !raw.includes('API_KEY=xxxx'), '密钥去掉了')
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
  assert.equal(kids.errors, 1, '报错只数消息上的 error，失败的工具调用单独计')
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

test('统计：节点级工具调用、探路失败和缓存写入进导出与报告', () => {
  const rec = Task.parse({
    ...task,
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 300, costUsd: 0.01 },
    steps: [
      {
        id: 'handle',
        title: '处理并推荐',
        agentId: coder.id,
        status: 'done',
        startedAt: at,
        endedAt: '2026-10-19T00:01:00.000Z',
        rounds: 1,
        verdict: 'pass',
        output: '做完了',
        usage: {
          inputTokens: 1000,
          cacheReadTokens: 600,
          cacheWriteTokens: 300,
          outputTokens: 200,
          costUsd: 0.01,
        },
      },
    ],
    messages: [
      {
        id: 'm1',
        role: 'agent',
        step: 'handle',
        text: '读文件',
        at,
        tools: [
          { kind: 'read', label: 'a.txt' },
          {
            kind: 'run',
            label: 'cat missing.txt',
            failed: true,
            output: 'cat: missing.txt: No such file or directory',
          },
          { kind: 'run', label: 'npm test', failed: true, exitCode: 1, output: 'failed: 断言没过' },
        ],
      },
      {
        id: 'm2',
        role: 'agent',
        step: '',
        text: '节点外的调用',
        at,
        tools: [{ kind: 'other', label: 'spawn', failed: true, output: 'Tool not found: spawn' }],
      },
    ],
  })
  const s = taskStats(rec, new Date(at).getTime())
  const n = s.nodes[0]
  assert.equal(n.cacheWriteTokens, 300, '节点要带上缓存写入 token')
  assert.equal(n.costUsd, 0.01, '节点费用读 StepUsage，不另算一份')
  assert.equal(n.toolCalls, 3, '节点里的工具调用总数')
  assert.equal(n.failedTools, 2)
  assert.deepEqual(n.probeBy, { tool: 0, path: 1, command: 0 }, '只有路径不存在是探路失败')
  // 合计和节点对得上：探路失败是失败工具调用的一部分，不是另一个指标
  assert.equal(s.toolCalls, 4, '节点外那次调用也算任务合计')
  assert.equal(s.failedTools, 3)
  assert.deepEqual(s.probeBy, { tool: 1, path: 1, command: 0 })

  const md = taskReport(exportTask(rec, [coder], '', new Date(at)))
  assert.match(md, /\| 费用 \|/, '节点表要能直接看到费用')
  assert.match(md, /输入\/缓存写\/命中/, '缓存写入和命中在同一处')
  // 失败的工具调用从「报错」那一行挪出来单独一行，避免同一个数在报告里出现两次
  assert.match(md, /；报错 0 条$/m)
  // 失败的工具调用从「报错」里拆出来单独一行，探路失败和节点外合成一个括号（评审 R2 / R3）
  assert.match(
    md,
    /- 工具调用 4 次，失败 3 次（其中探路失败 2 次：工具不存在 1、路径不存在 1；1 次不属于任何节点，失败 1 次）$/m,
  )
  // 任务级 Token 行也写缓存写入，不用复盘时自己加（评审低级）
  assert.match(md, /缓存写入 300/)
  assert.match(md, /\| 3 次，失败 2（探路 1） \|/, '节点表里写这个节点自己的工具调用')

  const html = taskHtml(exportTask(rec, [coder], '', new Date(at)))
  assert.ok(
    html.includes(
      '工具调用 4 次，失败 3 次（其中探路失败 2 次：工具不存在 1、路径不存在 1；1 次不属于任何节点，失败 1 次）',
    ),
  )

  // 旧导出里没有探路和工具调用字段：按 0 兜底，报告里不能出现 undefined
  const legacy = { ...exportTask(rec, [coder], '', new Date(at)) }
  const raw = legacy.stats as Record<string, unknown>
  // 旧包的 errors 是旧口径（把失败工具也算进去），这里放一个旧值 3，看报告会不会沿用
  legacy.stats = { ...raw, toolCalls: undefined, probeBy: undefined, errors: 3 }
  const old = taskReport(legacy)
  assert.ok(!old.includes('undefined'))
  assert.match(old, /- 工具调用 4 次，失败 3 次/, '旧数据没有这些字段时按记录现算，不写成 0')
  assert.match(old, /；报错 0 条$/m, '旧包的 errors 含失败工具，按记录现算成新口径，不沿用旧数')
})

test('报告：旧导出带了子对话时，子对话与合计行不会写出 undefined / NaN', () => {
  // 旧包里的 children / combined 是没有 toolCalls 等字段的 StatsTotal：只兜底顶层不够（评审 R1）
  const kid = Task.parse({ ...task, id: 'kid', parentTaskId: 't1', title: '子对话', steps: [], messages: [] })
  const b = exportTask(task, [coder], '', new Date(at), descendantTotals([kid]))
  const raw = b.stats as Record<string, Record<string, unknown>>
  const strip = (t: Record<string, unknown>) => ({
    ...t,
    toolCalls: undefined,
    failedTools: undefined,
    probeBy: undefined,
    cacheWriteTokens: undefined,
  })
  b.stats = { ...strip(raw), errors: 3, children: strip(raw.children), combined: strip(raw.combined) }
  const md = taskReport(b)
  const html = taskHtml(b)
  for (const text of [md, html]) {
    assert.ok(!text.includes('undefined'), '不能把 undefined 写进报告')
    assert.ok(!text.includes('NaN'), '合计重算后不能出 NaN')
  }
  // 旧包的子对话没有工具数据：宁可不写，也不写一个假的「0 次」
  assert.ok(!/子对话 1 个[^\n]*工具调用 0 次/.test(md))
  // 合计行也不能把子对话缺失的调用当成 0 写出来，要注明旧记录没记（口径：0 和「没记录」不是一个意思）
  assert.ok(!/含子对话合计[^\n]*工具调用 0 次/.test(md), '合计行不写假的 0 次')
  assert.match(md, /工具调用旧记录没有记（这一项只含自身）/, '合计行写明旧记录没记工具调用')
  assert.match(md, /旧口径：含失败的工具调用，工具调用未记录/, '子对话行的报错写明是旧口径')
})

test('HTML 导出：和 Markdown 一样有节点统计表（费用 / 缓存写 / 工具调用）', () => {
  const html = taskHtml(exportTask(task, [coder], '', new Date(at)))
  assert.ok(html.includes('<section id="nodes">'), '节点统计单独一小节')
  assert.ok(html.includes('节点统计'))
  assert.ok(html.includes('输入/缓存写/命中'), '节点表带缓存写入')
  assert.ok(html.includes('工具调用'), '节点表带工具调用列')
  assert.ok(html.includes('费用'), '节点表带费用列')
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
  assert.equal(redactSecrets('token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), 'token: [已移除]')
  assert.equal(redactSecrets('Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxx'), 'Authorization: Bearer [已移除]')
  assert.equal(redactSecrets('password="hunter22"'), 'password="[已移除]"')
  assert.equal(redactSecrets('把 token 数量降下来'), '把 token 数量降下来')
})

test('分析：报告列出统计、工作流定义和过程；要求里列出可以改的对象，长度在输入上限内', () => {
  const b = exportTask(task, [coder])
  const report = analysisReport([b])
  assert.match(report, /缓存命中 600，60%/)
  assert.match(report, /node id: handle/)
  assert.match(report, /执行出错：超时/)
  const prompt = analysisPrompt([b])
  assert.match(prompt, /workflowId: w1｜日常开发/)
  assert.match(prompt, /flowId: main, nodeId: handle/)
  assert.match(prompt, /agentId: a1｜开发/)
  assert.ok(prompt.length < 20000)
  // 写了具体问题：只围绕这个问题找原因
  assert.match(analysisPrompt([b], '为什么慢'), /用户的问题：为什么慢/)
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
  assert.match(report, /工具调用 2 次，失败 1 次/, '工具调用总数和失败数进统计')
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
  assert.match(report, /跨度 2h 40m：执行 20m 0s（等你确认\/提问 0s 已含在其中），空闲 2h 20m/)
  assert.match(report, /轮次：用户消息 2 条，分成 2 轮执行/)
})

test('旧导出没有跨度和空闲字段：按记录现算，不写 NaN', () => {
  const b = exportTask(twoRounds(), [coder])
  const old = {
    ...b,
    stats: { durationMs: 20 * 60_000, waitMs: 0, turns: 1, turnsUnfinished: 0 },
  } as Parameters<typeof taskReport>[0]
  const report = taskReport(old)
  assert.match(report, /跨度 2h 40m：执行 20m 0s（等你确认\/提问 0s 已含在其中），空闲 2h 20m/)
  assert.match(report, /轮次：用户消息 2 条，分成 1 轮执行/)
  assert.ok(!report.includes('NaN'), '旧数据不把 NaN 交给用户')
})

/** 父对话 09:00–13:00（4 小时），两个子对话同时在 09:30–13:00 跑：并行，占用只算一次 3h 30m */
function withKids() {
  const root = Task.parse({
    ...task,
    id: 'p1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T13:00:00.000Z',
    runMs: 20 * 60_000,
    waitMs: 0,
    steps: [],
    messages: [
      { id: 'p-u1', role: 'user', text: '派两个子对话', at: '2026-10-19T09:00:00.000Z' },
      { id: 'p-a1', role: 'agent', agentId: coder.id, step: '', text: '都派完了', at: '2026-10-19T13:00:00.000Z' },
    ],
  })
  const kid = (id: string, title: string) =>
    Task.parse({
      ...root,
      id,
      parentTaskId: 'p1',
      title,
      createdAt: '2026-10-19T09:30:00.000Z',
      updatedAt: '2026-10-19T13:00:00.000Z',
      messages: [
        { id: `${id}-u1`, role: 'user', text: '看一下这个模块', at: '2026-10-19T09:30:00.000Z' },
        { id: `${id}-a1`, role: 'agent', agentId: coder.id, step: '', text: '看完了', at: '2026-10-19T13:00:00.000Z' },
      ],
    })
  return { root, kids: [kid('k1', '子对话一'), kid('k2', '子对话二')] }
}

test('统计：子对话在后台跑的时间不算父对话空闲，并行时只算一次', () => {
  const { root, kids } = withKids()
  const s = exportTaskTree(root, [root, ...kids], [coder]).stats as ReturnType<typeof taskStats>
  assert.equal(s.spanMs, 4 * 3_600_000, '跨度 09:00 到 13:00')
  assert.equal(s.childBusyMs, 3.5 * 3_600_000, '两个子对话完全重叠，只算一次')
  assert.equal(s.idleMs, 10 * 60_000, '空闲只剩父对话自己跑完、子对话跑完的那一段')
  // 同一段时间不能既算「子对话在跑」又算「空闲」：执行 + 等下一句 + 子对话占用 + 空闲 = 跨度
  assert.equal(s.durationMs + s.childBusyMs + s.idleMs, s.spanMs, '执行 + 子对话占用 + 空闲 = 跨度')
  const report = taskReport(exportTaskTree(root, [root, ...kids], [coder]))
  assert.match(report, /子对话占用 3h 30m/, '报告里写明扣掉了多少')
  assert.match(report, /空闲 10m 0s/)
  assert.match(report, /空闲是本任务和名下子对话都没在跑的时候/, '空闲的口径写准，不再说「没有进程在跑」')
})

test('统计：父一轮覆盖整条记录时，子对话在后台跑的时间仍不算空闲', () => {
  // 真实记录里对话轮从 beginTurn 到停止一直是 running：不能把整条轮次时间窗当成「父在跑」，
  // 否则子对话跑 3.5h 会被减成 0，用户最初投诉的「两个差不多的数字」原样保留
  const { root, kids } = withKids()
  const oneTurn = Task.parse({
    ...root,
    runMs: 20 * 60_000,
    turns: [
      {
        id: 'r1',
        title: '派两个子对话',
        status: 'stopped',
        startedAt: '2026-10-19T09:00:00.000Z',
        endedAt: '2026-10-19T13:00:00.000Z',
        from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
      },
    ],
  })
  const b = exportTaskTree(oneTurn, [oneTurn, ...kids], [coder])
  const s = b.stats as ReturnType<typeof taskStats>
  assert.equal(s.childBusyMs, 3.5 * 3_600_000, '子对话在后台跑的时间没有被轮次时间窗吞掉')
  assert.equal(s.idleMs, 10 * 60_000)
  assert.equal(s.durationMs + s.childBusyMs + s.idleMs, s.spanMs)
  const report = taskReport(b)
  assert.match(report, /子对话占用 3h 30m/)
  assert.doesNotMatch(report, /子对话的时间都落在本任务执行里/, '不能和执行 20m 自相矛盾')
})

test('统计：子对话与父执行交织、子对话先结束时，占用不会被夹掉', () => {
  // 父 09:00 开始、跑 10 分钟就停在等子对话，子对话 09:10–10:40 跑 90 分钟，父 11:00 才有下一条消息。
  // 等子对话的时间已经不算父执行（runner 在 listen(helpers) 里结算掉），子对话占用要全额算，
  // 不能被 min(占用, 跨度 - 执行) 夹掉一截、也不能再被算成空闲
  const root = Task.parse({
    ...task,
    id: 'mix1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    createdAt: '2026-10-19T09:00:00.000Z',
    runMs: 10 * 60_000,
    waitMs: 0,
    idleWaitMs: 0,
    steps: [],
    messages: [
      { id: 'mix1-u1', role: 'user', text: '派个活', at: '2026-10-19T09:00:00.000Z' },
      { id: 'mix1-u2', role: 'user', text: '结果呢', at: '2026-10-19T11:00:00.000Z' },
    ],
    turns: [
      {
        id: 'r1',
        title: '派个活',
        status: 'done',
        startedAt: '2026-10-19T09:00:00.000Z',
        endedAt: '2026-10-19T09:10:00.000Z',
        from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
      },
    ],
  })
  const kid = Task.parse({
    ...root,
    id: 'mix1-k',
    parentTaskId: 'mix1',
    title: '子对话',
    createdAt: '2026-10-19T09:10:00.000Z',
    runMs: 90 * 60_000,
    turns: [],
    messages: [
      { id: 'mix1-ku', role: 'user', text: '干活', at: '2026-10-19T09:10:00.000Z' },
      { id: 'mix1-ka', role: 'agent', agentId: coder.id, step: '', text: '干完了', at: '2026-10-19T10:40:00.000Z' },
    ],
  })
  const s = exportTaskTree(root, [root, kid], [coder]).stats as ReturnType<typeof taskStats>
  assert.equal(s.childBusyMs, 90 * 60_000, '子对话跑了 90 分钟，全额算占用')
  assert.equal(s.idleMs, 20 * 60_000, '真实空闲只有 10:40–11:00')
  assert.equal(s.durationMs + s.childBusyMs + s.idleMs, s.spanMs)
})

test('统计：父自己也在跑的那段不再从空闲里扣一次（四项之和正好是跨度）', () => {
  // 评审复现的场景：父 09:00–11:00 里 09:00–10:00 在跑，其中一段时间在等子对话（等子任务时 runMs 照样涨），
  // 子对话 09:10–11:00。父没在忙的只有 10:00–11:00，那段子对话还在跑，算「等子对话」而不是空闲
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  const root = Task.parse({
    ...task,
    id: 'p2',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T11:00:00.000Z',
    runMs: 60 * 60_000,
    waitMs: 0,
    steps: [],
    messages: [
      { id: 'p2-u1', role: 'user', text: '派个活', at: '2026-10-19T09:00:00.000Z' },
      // 子对话跑完、父对话被叫醒时用户发来的话：父记录的跨度到这里为止
      { id: 'p2-u2', role: 'user', text: '结果呢', at: '2026-10-19T11:00:00.000Z' },
    ],
    turns: [
      {
        id: 'r1',
        title: '派个活',
        status: 'done',
        startedAt: '2026-10-19T09:00:00.000Z',
        endedAt: '2026-10-19T10:00:00.000Z',
        from,
      },
    ],
  })
  const kid = Task.parse({
    ...root,
    id: 'k1run',
    parentTaskId: 'p2',
    title: '子对话',
    createdAt: '2026-10-19T09:10:00.000Z',
    turns: [],
    messages: [
      { id: 'k1run-u1', role: 'user', text: '干活', at: '2026-10-19T09:10:00.000Z' },
      { id: 'k1run-a1', role: 'agent', agentId: coder.id, step: '', text: '干完了', at: '2026-10-19T11:00:00.000Z' },
    ],
  })
  const s = exportTaskTree(root, [root, kid], [coder]).stats as ReturnType<typeof taskStats>
  assert.equal(s.childBusyMs, 60 * 60_000, '只算子对话与父执行不重叠的那段：10:00–11:00')
  assert.equal(s.idleMs, 0)
  // 同一段时间不能算两处：执行 + 等用户 + 等子对话 + 空闲 = 跨度
  assert.equal(s.durationMs + s.childBusyMs + s.idleMs, s.spanMs, '执行 + 子对话占用 + 空闲 = 跨度')
})

test('统计：子对话没在父对话跨度里跑时不扣空闲', () => {
  // 子对话的时间窗落在父记录跨度之外（父对话很早就结束了）：扣掉的部分不能超过跨度
  const { root, kids } = withKids()
  const lone = Task.parse({
    ...root,
    messages: [{ id: 'p-u1', role: 'user', text: '派两个子对话', at: root.createdAt }],
  })
  const s = taskStats(lone, Date.now(), NO_TOTALS, 99 * 3_600_000)
  assert.equal(s.childBusyMs, 0, '扣掉的不会超过跨度')
  assert.equal(s.idleMs, Math.max(0, s.spanMs - s.durationMs))
  // 算不出子对话占用的入口（没有子任务记录）：留空，报告里说明空闲可能还含着它们
  assert.equal(taskStats(kids[0]).childBusyMs, undefined)
})

test('统计：没正常结束的轮次按结局拆开写，旧记录算「原因没记录」', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  type End = 'done' | 'supersede' | 'user' | 'failed' | 'panel'
  const turn = (id: string, status: 'done' | 'stopped' | 'failed', end?: End) => ({
    id,
    title: id,
    status,
    startedAt: '2026-10-19T11:30:00.000Z',
    endedAt: '2026-10-19T11:40:00.000Z',
    from,
    ...(end ? { end } : {}),
  })
  const rec = Task.parse({
    ...twoRounds(),
    turns: [
      turn('t1', 'done', 'done'),
      turn('t2', 'stopped', 'supersede'),
      turn('t3', 'stopped', 'user'),
      turn('t4', 'failed', 'failed'),
      turn('t5', 'stopped', 'panel'),
      // 旧记录：只有 status，没有结局字段
      turn('t6', 'stopped'),
    ],
  })
  const s = taskStats(rec)
  assert.deepEqual(s.turnEnds, { done: 1, running: 0, supersede: 1, user: 1, failed: 1, panel: 1, unknown: 1 })
  assert.equal(s.turnsUnfinished, 5, '没正常结束的轮次等于各项结局相加')
  const report = taskReport(exportTask(rec, [coder]))
  assert.match(
    report,
    /其中 5 轮没有正常结束：被新消息接管 1 轮、用户停止 1 轮、失败 1 轮、面板停止 1 轮、原因没记录 1 轮/,
  )
})

test('统计：面板重启这类不经过 endTurn 的轮次，按任务的停止原因补上结局', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  const stopped = (id: string) => ({
    id,
    title: id,
    status: 'stopped' as const,
    startedAt: '2026-10-19T11:30:00.000Z',
    endedAt: '2026-10-19T11:40:00.000Z',
    from,
  })
  const base = twoRounds()
  // 面板重启：落盘时直接把 running 改成 stopped，没有 end 字段，但整条任务记着 stopReason
  const restart = Task.parse({ ...base, stopReason: 'restart', turns: [stopped('r1'), stopped('r2')] })
  assert.deepEqual(taskStats(restart).turnEnds, {
    done: 0,
    running: 0,
    supersede: 0,
    user: 0,
    failed: 0,
    panel: 2,
    unknown: 0,
  })
  assert.match(taskReport(exportTask(restart, [coder])), /面板停止 2 轮/)
  // 用户暂停
  const paused = Task.parse({ ...base, stopReason: 'user', turns: [stopped('r1')] })
  assert.deepEqual(taskStats(paused).turnEnds, {
    done: 0,
    running: 0,
    supersede: 0,
    user: 1,
    failed: 0,
    panel: 0,
    unknown: 0,
  })
  // 旧记录里 status 已经写着失败：按失败算，别挪到「原因没记录」
  const failed = Task.parse({
    ...base,
    turns: [{ ...stopped('r1'), status: 'failed' }, stopped('r2')],
  })
  assert.deepEqual(taskStats(failed).turnEnds, {
    done: 0,
    running: 0,
    supersede: 0,
    user: 0,
    failed: 1,
    panel: 0,
    unknown: 1,
  })
})

test('统计：导出时任务还在跑：跨度和执行算到导出那一刻，导入后数字不变', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  const running = Task.parse({
    ...task,
    id: 'run1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    status: 'running',
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T09:50:00.000Z',
    runMs: 60 * 60_000,
    waitMs: 0,
    steps: [],
    messages: [{ id: 'run1-u1', role: 'user', text: '跑一下', at: '2026-10-19T09:00:00.000Z' }],
    turns: [{ id: 'r1', title: '跑一下', status: 'running', startedAt: '2026-10-19T09:00:00.000Z', endedAt: '', from }],
  })
  const b = exportTask(running, [coder], '', new Date('2026-10-19T10:00:00.000Z'))
  const s = b.stats as ReturnType<typeof taskStats>
  assert.equal(s.spanMs, 60 * 60_000, '跨度算到导出这一刻')
  assert.ok(s.spanMs >= s.durationMs + s.waitMs, '跨度不能比执行时间还短')
  // 包里这一轮已经按导出这一刻收尾（end: 'panel'）：stats 和记录体说同一种话
  assert.deepEqual(s.turnEnds, { done: 0, running: 0, supersede: 0, user: 0, failed: 0, panel: 1, unknown: 0 })
  assert.equal(s.turnsUnfinished, 1, '这一轮没有正常结束（是被导出/面板收掉的）')
  const report = taskReport(b)
  assert.match(report, /面板停止 1 轮/)
  assert.match(report, /导出时任务还在跑/, '头部说明这是执行中的快照')
  assert.ok(!report.includes('原因没记录'), '还在跑不会被写成原因没记录')
  // 导入后再算：执行时长和导出时一致，不会凭空少一截
  const made = importTask(b, 'p9', 'n8', '2026-10-20T10:00:00.000Z')
  const again = taskStats(made, Date.parse('2026-10-20T10:00:00.000Z'))
  assert.equal(again.durationMs, s.durationMs, '导入后的执行时长和导出时一致')
  assert.equal(again.spanMs, s.spanMs, '导入后的跨度和导出时一致')
})

test('统计：正在执行的那一段还没结算进 runMs，导出时也要算进「执行」', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  const live = Task.parse({
    ...task,
    id: 'live1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    status: 'running',
    createdAt: '2026-10-19T09:00:00.000Z',
    updatedAt: '2026-10-19T09:00:00.000Z',
    // 这一轮刚开始：runMs 还没结算，只有 runStartedAt
    runMs: 0,
    runStartedAt: '2026-10-19T09:00:00.000Z',
    waitMs: 0,
    steps: [],
    messages: [{ id: 'live1-u1', role: 'user', text: '跑一下', at: '2026-10-19T09:00:00.000Z' }],
    turns: [{ id: 'r1', title: '跑一下', status: 'running', startedAt: '2026-10-19T09:00:00.000Z', endedAt: '', from }],
  })
  const s = exportTask(live, [coder], '', new Date('2026-10-19T10:00:00.000Z')).stats as ReturnType<typeof taskStats>
  assert.equal(s.durationMs, 60 * 60_000, '执行含正在跑的这段')
  assert.equal(s.spanMs, 60 * 60_000)
  assert.equal(s.idleMs, 0, '正在执行的时间不能算成空闲')
})

test('统计：真实对话里「等下一句」单独记，报告不会出现「其中等待 > 执行」', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  const live = Task.parse({
    ...task,
    id: 'real1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    status: 'running',
    createdAt: '2026-10-19T09:00:00.000Z',
    runMs: 0,
    runStartedAt: '2026-10-19T09:00:00.000Z',
    waitMs: 0,
    waitStartedAt: '',
    idleWaitMs: 0,
    idleWaitAt: '',
    steps: [],
    messages: [{ id: 'real1-u1', role: 'user', text: '跑一下', at: '2026-10-19T09:00:00.000Z' }],
    turns: [{ id: 'r1', title: '跑一下', status: 'running', startedAt: '2026-10-19T09:00:00.000Z', endedAt: '', from }],
  })
  // 用真实的时间函数走一遍：跑 5 分钟 → 答完停在等下一句 → 次日用户回复 → 再跑 3 分钟 → 结束
  pauseRun(live, Date.parse('2026-10-19T09:05:00.000Z'))
  resumeRun(live, Date.parse('2026-10-20T09:00:00.000Z'))
  pauseRun(live, Date.parse('2026-10-20T09:03:00.000Z'))
  endRun(live, new Date('2026-10-20T09:03:00.000Z'))

  const s = taskStats(live, Date.parse('2026-10-20T09:03:00.000Z'))
  assert.equal(s.durationMs, 8 * 60_000, '执行只有两段跑的 8 分钟')
  assert.equal(s.waitMs, 0, '没有等确认/提问')
  assert.equal(s.idleWaitMs, 23 * 3_600_000 + 55 * 60_000, '等下一句的 23h55m 单独记')
  assert.equal(s.durationMs + s.idleMs, s.spanMs, '执行 + 空闲 = 跨度')
  assert.ok(s.idleWaitMs <= s.idleMs, '等下一句是空闲的一部分，不会比空闲还大')
  const report = taskReport(exportTask(live, [coder], '', new Date('2026-10-20T09:03:00.000Z')))
  assert.match(report, /执行 8m 0s（等你确认\/提问 0s 已含在其中）/, '执行和等确认是同一段，写清楚装得下')
  assert.match(report, /空闲 23h 55m（其中等你回下一句 23h 55m）/, '等下一句算在空闲里，括号里的数不超过主数')
})

test('统计：面板重启留下的「正在等」记录不会让跨度随查看时间增长', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  // 重启落盘只清了 waitStartedAt 没清 idleWaitAt（老落盘路径）：任务已经停了，不能还按「现在」算等待
  const rec = Task.parse({
    ...task,
    id: 'restart1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    status: 'stopped',
    createdAt: '2026-10-19T09:00:00.000Z',
    runMs: 10 * 60_000,
    idleWaitMs: 0,
    // 重启落盘时漏清的开始时间：比最后一轮结束还晚，它是「等待到此为止」的时间点
    idleWaitAt: '2026-10-19T09:20:00.000Z',
    steps: [],
    messages: [{ id: 'restart1-u1', role: 'user', text: '跑一下', at: '2026-10-19T09:00:00.000Z' }],
    turns: [
      {
        id: 'r1',
        title: '跑一下',
        status: 'stopped',
        startedAt: '2026-10-19T09:00:00.000Z',
        endedAt: '2026-10-19T09:10:00.000Z',
        from,
      },
    ],
  })
  const threeDays = taskStats(rec, Date.parse('2026-10-22T09:00:00.000Z'))
  const aWeek = taskStats(rec, Date.parse('2026-10-26T09:00:00.000Z'))
  assert.equal(threeDays.spanMs, 20 * 60_000, '跨度到残留的等待时间点为止，不往后长')
  assert.equal(aWeek.spanMs, threeDays.spanMs, '跨度不随查看时间增长')
  assert.equal(aWeek.idleWaitMs, threeDays.idleWaitMs, '等待时间也不会越看越长')
  // 导出再导入：跨度不会因为清掉残留的开始时间而变小
  const b = exportTask(rec, [coder], '', new Date('2026-10-22T09:00:00.000Z'))
  const exported = b.stats as ReturnType<typeof taskStats>
  assert.equal(exported.spanMs, threeDays.spanMs)
  const made = importTask(b, 'p9', 'n7', '2026-10-23T09:00:00.000Z')
  assert.equal(taskStats(made, Date.parse('2026-10-23T09:00:00.000Z')).spanMs, exported.spanMs, '导入后跨度不变')
})

test('统计：旧记录的 waitMs 里超出执行的那部分是历史「等下一句」，不再和空闲重复算', () => {
  // 旧口径：答完等下一句也算在 waitMs 里（加了 idleWaitMs 之前的记录都是这样）
  const rec = Task.parse({
    ...task,
    id: 'legacy1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    createdAt: '2026-10-19T09:00:00.000Z',
    runMs: 8 * 60_000,
    waitMs: (23 * 60 + 55) * 60_000,
    idleWaitMs: 0,
    idleWaitAt: '',
    steps: [],
    messages: [
      { id: 'legacy1-u1', role: 'user', text: '跑一下', at: '2026-10-19T09:00:00.000Z' },
      { id: 'legacy1-u2', role: 'user', text: '继续', at: '2026-10-20T09:03:00.000Z' },
    ],
    turns: [],
  })
  const s = taskStats(rec, Date.parse('2026-10-20T09:03:00.000Z'))
  assert.equal(s.waitMs, 8 * 60_000, '等你确认最多和执行一样长')
  assert.equal(s.idleWaitMs, (23 * 60 + 47) * 60_000, '超出的部分是历史「等下一句」')
  assert.equal(s.durationMs + s.idleMs, s.spanMs, '执行 + 空闲 = 跨度，不重复计时')
  const report = taskReport(exportTask(rec, [coder]))
  assert.match(report, /执行 8m 0s（等你确认\/提问 8m 0s 已含在其中）/, '括号里的数不超过执行')
  assert.match(report, /空闲 23h 55m（其中等你回下一句 23h 47m）/, '超出的等待算在空闲里')
})

test('导出执行中的任务再导入：跨度不会被拉到导入那一刻', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  const live = Task.parse({
    ...task,
    id: 'live2',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    status: 'running',
    createdAt: '2026-10-19T09:00:00.000Z',
    runMs: 30 * 60_000,
    runStartedAt: '2026-10-19T09:30:00.000Z',
    waitMs: 0,
    idleWaitMs: 0,
    idleWaitAt: '',
    steps: [],
    messages: [{ id: 'live2-u1', role: 'user', text: '跑一下', at: '2026-10-19T09:00:00.000Z' }],
    turns: [{ id: 'r1', title: '跑一下', status: 'running', startedAt: '2026-10-19T09:00:00.000Z', endedAt: '', from }],
  })
  const b = exportTask(live, [coder], '', new Date('2026-10-19T10:00:00.000Z'))
  assert.equal(b.task.exportedWhileRunning, true, '包里标明这是当时还在跑的记录')
  assert.equal(b.task.turns[0].status, 'stopped', '还在跑的轮次按导出这一刻收尾')
  assert.equal(b.task.turns[0].endedAt, '2026-10-19T10:00:00.000Z')
  // 一天后导入再看：跨度仍是导出那一刻的 1 小时，不会被拉到导入时间
  const made = importTask(b, 'p9', 'n9', '2026-10-20T10:00:00.000Z')
  const s = taskStats(made, Date.parse('2026-10-20T10:00:00.000Z'))
  assert.equal(s.spanMs, 60 * 60_000, '跨度不随查看时间增长')
  assert.equal(s.turnEnds.running, 0, '导入后没有「还在执行」的轮次')
})

test('统计：等你处理与执行重叠时，报告写成执行的一部分，不引导读者做四项加法', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  // 等确认/提问期间 runMs 不清空：同一段时间既在执行里也在等待里（基线口径，不是这次引入的）
  const rec = Task.parse({
    ...task,
    id: 'overlap1',
    mode: 'chat',
    workflowId: '',
    workflows: [],
    createdAt: '2026-10-19T09:00:00.000Z',
    runMs: 60 * 60_000,
    waitMs: 60 * 60_000,
    steps: [],
    messages: [{ id: 'overlap1-u1', role: 'user', text: '确认一下', at: '2026-10-19T09:00:00.000Z' }],
    turns: [
      {
        id: 'r1',
        title: '确认一下',
        status: 'done',
        startedAt: '2026-10-19T09:00:00.000Z',
        endedAt: '2026-10-19T10:00:00.000Z',
        from,
      },
    ],
  })
  const s = taskStats(rec)
  assert.equal(s.idleMs, 0, '重叠时只会少算空闲，不会算出负数或超跨度')
  const report = taskReport(exportTask(rec, [coder]))
  assert.match(report, /执行 1h 0m（等你确认\/提问 1h 0m 已含在其中）/, '等确认写成执行的一部分')
})

test('统计：旧记录各轮停下原因不同时，只用最后一次的原因给最后那一轮兜底', () => {
  const from = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }
  const stopped = (id: string, startedAt: string, endedAt: string) => ({
    id,
    title: id,
    status: 'stopped' as const,
    startedAt,
    endedAt,
    from,
  })
  const two = twoRounds()
  const rec = Task.parse({
    ...two,
    stopReason: 'user',
    turns: [
      // 这一轮当年是被新消息接管的，但旧记录没记结局：留「原因没记录」，不能按后来那次 user 算
      stopped('r1', '2026-10-19T09:00:00.000Z', '2026-10-19T09:10:00.000Z'),
      stopped('r2', '2026-10-19T11:30:00.000Z', '2026-10-19T11:40:00.000Z'),
    ],
  })
  assert.deepEqual(taskStats(rec).turnEnds, {
    done: 0,
    running: 0,
    supersede: 0,
    user: 1,
    failed: 0,
    panel: 0,
    unknown: 1,
  })
})

test('统计：验收重做与节点重跑都记成返工，节点重跑清零 rounds 也不丢', () => {
  const rec = Task.parse({
    ...twoRounds(),
    steps: [
      // 新数据：验收不通过 2 次后重跑过一遍，rounds 清零后只剩 1 轮，reviews 还留着
      {
        id: 'dev',
        title: '开发',
        status: 'done',
        startedAt: at,
        endedAt: at,
        rounds: 1,
        verdict: 'pass',
        reruns: 1,
        reviews: 2,
      },
      // 旧记录没有 reviews：按 rounds 反推
      { id: 'old', title: '旧节点', status: 'done', startedAt: at, endedAt: at, rounds: 2, verdict: 'pass' },
    ],
  })
  assert.deepEqual(taskStats(rec).reworkBy, { review: 3, rerun: 1, merge: 0, sub: 0 })
})

test('报告：空闲的说明和实际算到的口径一致（没算 / 算过是 0 / 有占用）', () => {
  // 算过、但子对话整个落在父记录跨度之外：占用是 0，不能写成「没算」
  const { root, kids } = withKids()
  const outside = kids.map((k) =>
    Task.parse({
      ...k,
      createdAt: '2026-10-19T14:00:00.000Z',
      messages: [
        { id: `${k.id}-u1`, role: 'user', text: '晚点做', at: '2026-10-19T14:00:00.000Z' },
        {
          id: `${k.id}-a1`,
          role: 'agent',
          agentId: coder.id,
          step: '',
          text: '做完了',
          at: '2026-10-19T15:00:00.000Z',
        },
      ],
    }),
  )
  const noOverlap = taskReport(exportTaskTree(root, [root, ...outside], [coder]))
  assert.match(noOverlap, /名下子对话没有另外占掉这条记录里的时间/)
  // 没算：AI 分析的导出只带统计，拿不到子任务记录（web/src/lib/task-transfer.ts 那条路）
  const { root: top, child, grand } = tree()
  const noBusy = taskReport(exportTask(top, [coder], '', new Date(at), descendantTotals([child, grand])))
  assert.match(noBusy, /这条记录没算子对话的占用，空闲里可能还含它们的时间/)
})

test('统计：返工按验收重做、同一节点重跑、子对话收尾被驳回分开算', () => {
  const base = twoRounds()
  const rec = Task.parse({
    ...base,
    steps: [
      { id: 'dev', title: '开发', status: 'done', startedAt: at, endedAt: at, rounds: 2, verdict: 'pass' },
      // 验证节点跑了两遍（第一遍失败后重新执行），重新执行时 rounds 会清零，只能靠 reruns 看出来
      { id: 'verify', title: '验证', status: 'done', startedAt: at, endedAt: at, reruns: 2 },
    ],
    messages: [
      ...base.messages,
      {
        id: 'rej',
        role: 'system',
        step: '',
        text: '【父对话收尾】没能合回原分支：冲突',
        panel: 'build',
        peer: {
          id: 'p1',
          title: '父对话',
          name: '父对话',
          rel: 'parent',
          kind: 'merge',
          subject: '没能合回原分支：冲突',
          failed: true,
        },
        at,
      },
    ],
  })
  const s = taskStats(rec)
  assert.deepEqual(s.reworkBy, { review: 1, rerun: 2, merge: 1, sub: 0 })
  assert.equal(s.reworks, 4, '返工总数等于三项相加')
  const report = taskReport(exportTask(rec, [coder]))
  assert.match(report, /返工 4 次（验收不通过 1 次、同一节点重跑 2 次、子对话收尾被驳回 1 次）/)
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

test('统计：评审、测试验收的子任务给了不通过也记成返工（ADR 0009）', () => {
  const base = twoRounds()
  const sub = (id: string, output: string) => ({
    id,
    parentId: '@chat',
    slot: 'sub',
    title: '评审',
    status: 'done',
    startedAt: at,
    endedAt: at,
    output,
  })
  const rec = Task.parse({
    ...base,
    steps: [
      sub('h1', '验收结论：不通过\n必须改：R1'),
      // 首行通过、正文提到上一轮「不通过」的复看不算返工
      sub('h2', '验收结论：通过\n上一轮的「验收结论：不通过」都已改掉'),
      sub('h3', '查到了三处调用'),
    ],
  })
  const s = taskStats(rec)
  assert.equal(s.reworkBy.sub, 1)
  assert.equal(s.reworks, 1)
  assert.match(taskReport(exportTask(rec, [coder])), /子任务验收不通过 1 次/)
})

test('统计：父对话交过来的消息不算用户消息，过程里写清是谁发的', () => {
  const base = twoRounds()
  const rec = Task.parse({
    ...base,
    messages: [
      ...base.messages,
      {
        id: 'p1',
        role: 'user',
        text: '## 父对话替你定的方向：A',
        at: '2026-10-19T11:35:00.000Z',
        peer: { id: 'parent', name: '统筹', rel: 'parent', kind: 'answer' },
      },
    ],
  })
  assert.equal(taskStats(rec).asks, 2)
  const md = taskReport(exportTask(rec, [coder]))
  assert.match(md, /用户消息 2 条/)
  assert.match(md, /父对话（统筹）发来/)
})
