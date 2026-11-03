import assert from 'node:assert/strict'
import test from 'node:test'
import type { Orchestra } from '../shared/engine.ts'
import { pickFlow, type WorkflowEntry } from '../shared/flow-child.ts'
import type { Task } from '../shared/schema.ts'
import { callStartWorkflow } from './start-workflow-tool.ts'

const LIST: WorkflowEntry[] = [
  { id: 'g', name: '通用项目', description: '默认', steps: [], kind: 'change' },
  { id: 'r', name: '代码评审', description: '只读评审', steps: [], kind: 'readonly' },
]

test('start_workflow：认出工作流再开工作流子对话；带 again 在原来的子对话里再跑一次；认不出不开', async () => {
  const made: { title: string; flow?: Task['flow']; step?: string }[] = []
  const sent: { id: string; rerun?: boolean }[] = []
  const o = {
    pickWorkflow: (k: string) => pickFlow(LIST, k),
    createConversation: async (
      title: string,
      _m: string,
      _f?: string[],
      step?: string,
      extra?: { flow?: Task['flow'] },
    ) => {
      made.push({ title, flow: extra?.flow, step })
      return { ok: true, id: 'k1', info: '已新建' }
    },
    sendToConversation: async (id: string, _m: string, _s?: string, _r?: unknown, rerun?: boolean) => {
      sent.push({ id, rerun })
      return { ok: true, info: '已交给它' }
    },
  } as unknown as Orchestra
  const text = (r: { content: { text: string }[] }) => r.content[0].text
  assert.match(text(await callStartWorkflow(o, { input: '' })), /input 是空的/)
  assert.match(text(await callStartWorkflow(o, { workflow: '不存在', input: '做' })), /没有「不存在」这个工作流/)
  assert.equal(made.length, 0)
  assert.match(text(await callStartWorkflow(o, { workflow: 'g', input: '做登录', step: '2' })), /已新建（id: k1）/)
  assert.equal(made[0].flow?.input, '做登录')
  assert.equal(made[0].step, '2')
  assert.match(made[0].title, /^通用项目：做登录/, '没给标题时用工作流名字加要做的事')
  await callStartWorkflow(o, { again: 'k1', input: '方案改成用缓存' })
  assert.deepEqual(sent, [{ id: 'k1', rerun: true }])
})
