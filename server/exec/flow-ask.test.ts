/** 工作流节点在提问关着时的提问：记成「待你决定」、回答里写明收不回的事先不做。运行：npm run test:unit */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task } from '../../shared/schema.ts'
import { FLOW_AUTO_ANSWER, flowAutoAnswer } from './flow-ask.ts'

test('只有工作流节点里的调用改答；问题记进对话、不停下等', () => {
  const task = { messages: [] } as unknown as Task
  let saved = 0
  const base = { task, agentId: 'a', newId: () => 'm1', changed: () => void saved++ }
  assert.equal(flowAutoAnswer({ ...base, step: '' }), undefined)
  const fn = flowAutoAnswer({ ...base, step: 'wrapup' })!
  const r = fn({ title: '提问', detail: '', questions: [{ question: '要不要改 SubModuleList_BigWorld.lua？' }] })
  assert.equal(r, FLOW_AUTO_ANSWER)
  assert.match(r, /收不回.*先不做.*写成决策/)
  assert.equal(task.messages.length, 1)
  assert.match(String(task.messages[0].text), /待你决定.*SubModuleList_BigWorld\.lua/)
  assert.equal(saved, 1)
})
