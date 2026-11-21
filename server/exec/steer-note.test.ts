/**
 * 执行中插话的说明：对话里先判断相关性，相关的调整方向，无关的等当前任务做完再处理。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import { continuesOutput } from './event-kinds.ts'
import { steerFrom, steerNote } from './steer-note.ts'
import type { TaskMessage } from '../../shared/schema.ts'

setLang('zh')

test('对话里的补充：先判断相关性，无关的等当前任务做完再处理', () => {
  const note = steerNote('顺便看看天气', { chat: true })
  assert.match(note, /先判断它和当前任务的关系/)
  assert.match(note, /按它调整方向/)
  assert.match(note, /做完后再处理这条内容/)
  assert.match(note, /顺便看看天气$/)
})

test('工作流的补充：仍然交给节点结合当前任务处理', () => {
  const note = steerNote('加一条日志', { chat: false })
  assert.doesNotMatch(note, /无关/)
  assert.match(note, /结合它继续当前的任务/)
  assert.match(note, /加一条日志$/)
})

test('父对话 / 面板发来的消息不说成用户补充，让模型按它处理并回复', () => {
  const note = steerNote('【状态询问】你已经 3 分钟没有输出了', { chat: true, fromParent: true })
  assert.match(note, /父对话 \/ 面板在你执行中发来一条消息/)
  assert.match(note, /不是用户发的补充/)
  assert.match(note, /按它处理并回复/)
  assert.doesNotMatch(note, /用户在你执行中补充了信息/)
})

test('父对话（派过子对话）收到用户补充：先分清是谁的事，子对话的事马上转、带上 quote，不压到手上的事做完以后', () => {
  const from = steerFrom({ mode: 'agent', parentTaskId: '', routes: [{ target: 'child' }], bug: undefined } as never, {
    id: 'u9',
    peer: undefined,
  })
  assert.equal(from.coordinator, true)
  const note = steerNote('直接改 GetDecorationActorTopLocation', from)
  assert.match(note, /你是父对话/)
  assert.match(note, /现在就用 send_to_conversation 交给那个子对话/)
  assert.match(note, /quote 写 \["u9"\]/)
  assert.match(note, /不要先把手上的事做完再转/)
  assert.match(note, /changelist 描述/)
  // 还没派过子对话的顶层对话照通用说法
  const plain = steerFrom({ mode: 'agent', parentTaskId: '', routes: [], bug: undefined } as never)
  assert.equal(plain.coordinator, false)
  assert.doesNotMatch(steerNote('x', plain), /你是父对话/)
})

test('走 Bug 诊断流程的子对话收到用户点名的修法：当成对报告的意见，核实、比较，换方案交 plan 出新一版', () => {
  const task = {
    mode: 'agent',
    parentTaskId: 'p1',
    routes: [],
    bug: { kind: 'report', diagnoses: [{ status: 'approved', phase: 'fix' }] },
  } as never
  const from = steerFrom(task, { id: 'u1', peer: undefined })
  assert.equal(from.bug, true)
  assert.equal(from.coordinator, false)
  const note = steerNote('用PlotActor吧', from)
  assert.match(note, /当成对诊断报告的意见/)
  assert.match(note, /不要直接说「这就是方案 X」/)
  assert.match(note, /phase: plan/)
  assert.match(note, /fromChat/)
  // 父对话转来的话（可能带着用户原话）同样带上这一段
  const parent = steerNote('用户改了修法', steerFrom(task, { id: 'x', peer: { rel: 'parent' } as never }))
  assert.match(parent, /父对话 \/ 面板在你执行中发来一条消息/)
  assert.match(parent, /当成对诊断报告的意见/)
  // 没在走诊断流程的不加
  assert.doesNotMatch(steerNote('x', { chat: true }), /诊断报告/)
})

test('插话收下时正说到一半：同一段正文、思考接着写在原来那条，换成工具或新一次回应才另起一条', () => {
  const msg = (m: Partial<TaskMessage>) => ({ text: '', tools: [], ...m }) as TaskMessage
  const speaking = msg({ text: '用户补充的「修复后合并' })
  // 用户报过：后半句「到主干」记下了」跑到了用户消息下面
  assert.equal(continuesOutput({ type: 'text_delta', text: '到主干」' }, speaking), true)
  assert.equal(continuesOutput({ type: 'usage', addOutput: 3 }, speaking), true)
  assert.equal(continuesOutput({ type: 'request_start' }, speaking), false, '新一次模型回应排在用户消息后面')
  assert.equal(continuesOutput({ type: 'thinking', text: '…' }, speaking), false)
  assert.equal(continuesOutput({ type: 'tool', tool: { kind: 'run', label: 'ls', detail: '' } }, speaking), false)
  // 还在想、没开始说：思考接着写；正文开始了就算新的一段
  const thinking = msg({ thinking: '先看' })
  assert.equal(continuesOutput({ type: 'thinking', text: '一下' }, thinking), true)
  assert.equal(continuesOutput({ type: 'text_delta', text: '好' }, thinking), false)
  // 只有工具的那条、或者还没有输出：马上断开
  assert.equal(
    continuesOutput({ type: 'text_delta', text: '好' }, msg({ tools: [{ kind: 'run', label: 'ls', detail: '' }] })),
    false,
  )
  assert.equal(continuesOutput({ type: 'text_delta', text: '好' }, undefined), false)
})
