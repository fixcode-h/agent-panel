import assert from 'node:assert/strict'
import test from 'node:test'
import { flowLine, flowPhase, pickFlow, workflowCatalogText, type WorkflowEntry } from './flow-child.ts'
import type { Task, TaskStep } from './schema.ts'

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
