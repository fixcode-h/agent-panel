import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canStartFlow,
  flowLine,
  namedWorkflow,
  withWorkflow,
  flowPhase,
  pickFlow,
  workflowCatalogText,
  workflowPrompt,
  type WorkflowEntry,
} from './flow-child.ts'
import type { Task, TaskStep } from './schema.ts'
import { taskTitle } from './task.ts'

/** 工作流子对话（ADR 0044）：这一轮跑流程图的哪一段、进度怎么说、父对话怎么挑工作流 */
const step = (id: string, status: TaskStep['status'], title = id) => ({ id, title, status, parentId: '' }) as TaskStep
const kid = (extra: Partial<Task> = {}) =>
  ({
    status: 'running',
    runSeq: 1,
    runs: [{ id: 1, status: 'running' }],
    steps: [step('a', 'done', '实现'), step('b', 'running', '验收'), step('c', 'pending', '文档')],
    flow: { workflowId: 'wf', workflowName: '通用项目', input: '做功能', kind: 'change', run: 1, handed: false },
    ...extra,
  }) as unknown as Task

test('flowPhase：没开始起新运行，停下接着跑，失败重跑；交出去或被终止后按普通子对话走', () => {
  assert.equal(flowPhase(kid({ flow: { ...kid().flow!, run: 0 } })), 'start')
  assert.equal(flowPhase(kid({ runs: [{ id: 1, status: 'stopped' }] as Task['runs'] })), 'continue')
  assert.equal(flowPhase(kid({ runs: [{ id: 1, status: 'failed' }] as Task['runs'] })), 'retry')
  assert.equal(flowPhase(kid({ flow: { ...kid().flow!, handed: true } })), undefined)
  assert.equal(flowPhase(kid({ flow: { ...kid().flow!, cancelled: true } })), undefined)
  assert.equal(flowPhase(kid({ flow: undefined })), undefined)
})

test('flowLine：父对话看到的进度说清做到哪、停在哪、下一步怎么办', () => {
  assert.equal(flowLine(kid()), '工作流「通用项目」：1/3，正在跑「验收」')
  const failed = kid({
    status: 'failed',
    runs: [{ id: 1, status: 'failed' }] as Task['runs'],
    steps: [step('a', 'done', '实现'), step('b', 'failed', '验收'), step('c', 'pending', '文档')],
  })
  assert.match(flowLine(failed), /停在「验收」.*等你给意见重跑或 stop_workflow 终止/)
  assert.match(
    flowLine(kid({ status: 'stopped', runs: [{ id: 1, status: 'stopped' }] as Task['runs'] })),
    /暂停在「验收」/,
  )
  assert.match(flowLine(kid({ flow: { ...kid().flow!, handed: true } })), /执行角色在收尾/)
  assert.equal(flowLine(kid({ flow: undefined })), '')
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
