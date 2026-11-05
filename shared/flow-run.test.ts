import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canStartFlow,
  decisionsText,
  namedWorkflow,
  noteConfirm,
  overLimit,
  rewindTo,
  runEntry,
  runLine,
  runsSection,
  withWorkflow,
  pickFlow,
  workflowCatalogText,
  workflowPrompt,
  type WorkflowEntry,
} from './flow-run.ts'
import { FlowRun } from './task-flow-schema.ts'
import { WRAP_FLOW, WRAP_NODE, withWrapUp, wrapRoles } from './flow-run-wrap.ts'
import { Workflow, type Task, type TaskStep } from './schema.ts'
import { taskTitle } from './task.ts'

/** 工作流运行（docs/openspec/changes/workflow-runs/design.md）：进度怎么说、决定记录、退回、父对话怎么挑工作流 */
const step = (id: string, status: TaskStep['status'], title = id, extra: Partial<TaskStep> = {}) =>
  ({ id, title, status, parentId: '', ...extra }) as TaskStep
const run = (extra: Partial<Task> = {}, f: Partial<FlowRun> = {}) =>
  ({
    id: 'r1',
    title: '做导出',
    status: 'running',
    runSeq: 1,
    updatedAt: '2026-11-05T00:00:00Z',
    steps: [step('a', 'done', '实现'), step('b', 'running', '验收'), step('c', 'pending', '文档')],
    flowRun: FlowRun.parse({ owner: 'p', workflowName: '通用项目', input: '做导出', ...f }),
    ...extra,
  }) as unknown as Task

test('runLine：父对话看到的进度说清阶段、做到哪、下一步怎么办', () => {
  assert.equal(runLine(runEntry(run())!), '工作流「通用项目」（id r1）：1/3，在跑「验收」')
  const confirm = run(
    { steps: [step('a', 'done', '实现'), step('b', 'running', '验收', { awaitConfirm: true }), step('c', 'pending')] },
    { phase: 'confirm' },
  )
  assert.match(runLine(runEntry(confirm)!), /「验收」做完了，等用户确认/)
  const paused = run({ status: 'stopped' })
  assert.match(runLine(runEntry(paused)!), /已暂停（重启后从这里接着走）/)
  assert.match(runLine(runEntry(run({}, { phase: 'ready' }))!), /等你合回（finish_workflow/)
  const failed = run({ status: 'failed', steps: [step('a', 'done'), step('b', 'failed', '验收')] }, { phase: 'failed' })
  assert.match(runLine(runEntry(failed)!), /节点「验收」失败，等决定/)
  assert.equal(runEntry({ ...run(), flowRun: undefined }), undefined)
})

test('runsSection：只列没结束的；全结束了不写这一节', () => {
  const live = runEntry(run())!
  const done = runEntry(run({ id: 'r2' }, { phase: 'done' }))!
  assert.match(runsSection([live, done]), /^## 名下的工作流\n- 工作流「通用项目」（id r1）/)
  assert.ok(!runsSection([live, done]).includes('r2'))
  assert.equal(runsSection([done]), '')
})

test('决定记录：确认、修改、补充进之后节点的提示，追问不进；父对话代答记成父对话的决定', () => {
  const f = FlowRun.parse({ owner: 'p', notes: ['日志用英文'] })
  noteConfirm(f, '方案', { allow: false, answer: '加上回滚' })
  noteConfirm(f, '方案', { allow: false, ask: true, answer: '为什么用缓存' })
  noteConfirm(f, '方案', { allow: true })
  noteConfirm(f, '实现', { allow: false, answer: '改小一点' }, 'parent')
  assert.equal(f.phase, 'running')
  const text = decisionsText(f)
  assert.match(text, /用户要求修改「方案」：加上回滚/)
  assert.match(text, /用户确认「方案」/)
  assert.match(text, /用户要求修改「实现」：（父对话代答）改小一点/)
  assert.match(text, /补充说明：日志用英文/)
  assert.ok(!text.includes('为什么用缓存'), '追问只回答问题，不当成要求')
  assert.equal(decisionsText(FlowRun.parse({ owner: 'p' })), '')
})

test('修改轮次上限：超过只提示（不强制终止）；0 不提示；追问不计', () => {
  const f = FlowRun.parse({ owner: 'p', reviseLimit: 2 })
  for (let i = 0; i < 3; i++) noteConfirm(f, '方案', { allow: false, answer: `第 ${i} 次` })
  noteConfirm(f, '实现', { allow: false, ask: true, answer: '问' })
  assert.deepEqual(overLimit(f), ['方案'])
  assert.deepEqual(overLimit({ ...f, reviseLimit: 0 }), [])
})

test('rewindTo：退回的节点和之后的节点、连同节点下面的步骤记录一起改回待执行', () => {
  const tk = {
    steps: [
      step('a', 'done', '方案'),
      step('a/s1', 'done', '写方案', { parentId: 'a' }),
      step('b', 'done', '实现', { awaitConfirm: true }),
      step('b/s1', 'done', '改代码', { parentId: 'b' }),
      step('c', 'pending', '文档'),
    ],
  } as unknown as Task
  const back = rewindTo(tk, '实现').map((s) => s.id)
  assert.deepEqual(back, ['b', 'c'])
  const st = Object.fromEntries(tk.steps.map((s) => [s.id, s.status]))
  assert.deepEqual(st, { a: 'done', 'a/s1': 'done', b: 'pending', 'b/s1': 'pending', c: 'pending' })
  assert.ok(!tk.steps.find((s) => s.id === 'b')!.awaitConfirm)
  assert.deepEqual(rewindTo(tk, '不存在'), [])
})

const LIST: WorkflowEntry[] = [
  {
    id: 'g',
    name: '通用项目',
    description: '默认',
    steps: ['方案', '实现'],
    when: '正式功能',
    notFor: '小改动',
    kind: 'change',
  },
  { id: 'r', name: '代码评审', description: '只读评审', steps: [], when: '用户要求评审', kind: 'readonly' },
]

test('pickFlow：按 id 或名字找，空是默认的；找不到列出能用的', () => {
  const byName = pickFlow(LIST, '代码评审')
  assert.ok(byName.ok && byName.flow.workflowId === 'r' && byName.flow.kind === 'readonly')
  const dflt = pickFlow(LIST, '')
  assert.ok(dflt.ok && dflt.flow.workflowId === 'g')
  const none = pickFlow(LIST, 'Bug 修复')
  assert.ok(!none.ok && /通用项目（id g）、代码评审（id r）/.test(none.info))
  assert.ok(!pickFlow([], '').ok)
})

test('可用工作流目录：带适用、不用、只读和判定规则；没有工作流时说交给子对话', () => {
  const text = workflowCatalogText(LIST)
  assert.match(text, /- id: g｜通用项目（默认）：默认（节点：方案 → 实现）\n {2}适用：正式功能；不用：小改动/)
  assert.match(text, /- id: r｜代码评审：只读评审\n {2}适用：用户要求评审；只读/)
  assert.match(text, /问答和分析、排查和 Bug 定位、一两个文件的小改动/)
  assert.match(text, /拿不准就交给子对话/)
  assert.match(workflowCatalogText([]), /项目还没有配置工作流/)
})

test('用户点名工作流（「在项目里运行」、输入框引入工作流）：要求带名字和 id；只有能开子对话又能启动工作流的角色才给入口', () => {
  assert.equal(workflowPrompt({ id: 'g', name: '通用项目' }, '  做功能\n'), '用工作流「通用项目」（id g）做：\n做功能')
  const agents = [
    { id: 'lead', canDelegate: true, canPlan: true },
    { id: 'exec', canDelegate: true, canPlan: false },
  ]
  assert.ok(canStartFlow(agents, 'lead'))
  assert.ok(!canStartFlow(agents, 'exec'))
  assert.ok(!canStartFlow(agents, ''), '不用角色的对话没有 start_workflow')
})

test('输入框里的工作流卡片：发送时摘掉卡片、要求点名它；找不到只写名字；发出去的消息拆得回卡片', () => {
  const flows = [{ id: 'g', name: '通用项目' }]
  assert.equal(withWorkflow('[工作流:通用项目] 加个导出按钮', flows), '用工作流「通用项目」（id g）做：\n加个导出按钮')
  assert.equal(withWorkflow('加个导出按钮 [工作流:旧名字]', flows), '用工作流「旧名字」做：\n加个导出按钮')
  assert.equal(withWorkflow('不带工作流 [图片:a.png]', flows), '不带工作流 [图片:a.png]')
  assert.deepEqual(namedWorkflow('用工作流「通用项目」（id g）做：\n加个导出按钮'), {
    name: '通用项目',
    rest: '加个导出按钮',
  })
  assert.deepEqual(namedWorkflow('用工作流「旧名字」做：\n加'), { name: '旧名字', rest: '加' })
  assert.equal(namedWorkflow('用工作流做个东西'), undefined)
  assert.equal(taskTitle('用工作流「通用项目」（id g）做：\n加个导出按钮'), '加个导出按钮', '对话标题取用户写的要求')
})

test('收尾：入口流程连到结束的线改连到收尾节点，验收流程是评审 → 测试；接过的不重复接，没有执行角色不接', () => {
  const w = Workflow.parse({
    id: 'w',
    createdAt: '',
    updatedAt: '',
    name: '流程',
    flows: [
      {
        id: 'main',
        nodes: [{ id: 'a', title: '实现', agentId: 'x' }],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'end' },
        ],
      },
    ],
  })
  const roles = { worker: 'wk', reviewer: 'rv', tester: 'ts' }
  const got = withWrapUp(w, roles)
  const main = got.flows[0]
  assert.deepEqual(
    main.edges.map((e) => `${e.from}>${e.to}`),
    ['start>a', 'a>wrapup', 'wrapup>end'],
  )
  const wrap = main.nodes.find((n) => n.id === WRAP_NODE)!
  assert.equal(wrap.agentId, 'wk')
  assert.deepEqual(wrap.hooks.review, { kind: 'sub', id: WRAP_FLOW })
  const rf = got.flows.find((f) => f.id === WRAP_FLOW)!
  assert.deepEqual(
    rf.edges.map((e) => `${e.from}>${e.to}${e.when ? `:${e.when}` : ''}`),
    ['start>review', 'review>test:pass', 'test>end', 'review>end:fail'],
    '评审不通过就不用测了，意见直接作为结果交回',
  )
  assert.equal(withWrapUp(got, roles), got, '接过的不重复接')
  assert.equal(withWrapUp(w, { reviewer: 'rv' }), w, '没有执行角色不接')
  assert.equal(withWrapUp(w, { worker: 'wk' }).flows[0].nodes.at(-1)?.hooks.review, null, '没有评审和测试时只补齐提交')
  assert.deepEqual(
    wrapRoles([
      { id: 'a', origin: 'builtin:worker' },
      { id: 'b', origin: 'builtin:reviewer', enabled: false },
    ]),
    {
      worker: 'a',
      reviewer: undefined,
      tester: undefined,
    },
  )
})
