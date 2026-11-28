/**
 * 模型在写工具调用的入参时记「正在写」（drafting.ts）：开始写就记，调用到了、开始说话、这一轮结束就去掉。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task } from '../../shared/schema.ts'
import { createDrafting } from './drafting.ts'

test('开始写工具调用时记下、入参实时转成文字，调用到了就去掉；不带工具名的生成不动它', () => {
  const task: Pick<Task, 'drafting'> = {}
  let n = 0
  const d = createDrafting(task, () => n++)
  // 读的时候别让 TS 按上一句断言收窄（see 会改它）
  const cur = () => task.drafting
  d.see({ type: 'gen', text: '{"pha' })
  assert.equal(task.drafting, undefined)
  d.see({ type: 'gen', text: '', tool: 'mcp__panel__submit_diagnosis' })
  assert.equal(cur()?.tool, 'mcp__panel__submit_diagnosis')
  d.see({ type: 'gen', text: '{"pha' })
  d.see({ type: 'gen', text: 'se":"plan"' })
  assert.equal(cur()?.text, 'phase：plan', '入参边收边转成能读的文字')
  d.see({ type: 'usage', addOutput: 3 })
  assert.ok(cur(), '写入参、用量这些事件不打断')
  d.see({ type: 'tool', tool: { kind: 'other', label: '', detail: '' } })
  assert.equal(cur(), undefined)
  d.see({ type: 'gen', text: '', tool: 'Write' })
  d.clear()
  assert.equal(cur(), undefined, '这一轮结束（进程退出）也去掉')
  assert.equal(n, 4)
})

test('只有登记过的工具推写到哪了：更新计划只转圈，开子对话只显示标题和任务说明', () => {
  const task: Pick<Task, 'drafting'> = {}
  const d = createDrafting(task, () => {})
  const cur = () => task.drafting
  d.see({ type: 'gen', text: '', tool: 'mcp__agent-panel__set_plan' })
  d.see({ type: 'gen', text: '{"title":"碰杯","steps":["a"]}' })
  assert.equal(cur()?.tool, 'mcp__agent-panel__set_plan')
  assert.equal(cur()?.text, undefined, '普通工具不推内容')
  d.see({ type: 'tool', tool: { kind: 'other', label: '', detail: '' } })
  d.see({ type: 'gen', text: '', tool: 'mcp__agent-panel__create_conversation' })
  d.see({ type: 'gen', text: '{"agent":"coder","title":"切主角",' })
  d.see({ type: 'gen', text: '"message":"进入时\\n换人","files":["a.lua"]}' })
  assert.equal(cur()?.text, '短标题：切主角\n\n任务说明：进入时\n换人', '其余字段不显示，字段名换成界面叫法')
})

test('调用到了记下写参数用了多久；一条回复连写几个调用按顺序认领', async () => {
  const task: Pick<Task, 'drafting'> = {}
  const d = createDrafting(task, () => {})
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  d.see({ type: 'gen', text: '', tool: 'Read' })
  await wait(30)
  d.see({ type: 'gen', text: '', tool: 'mcp__agent-panel__spawn_agents' })
  await wait(60)
  const a = { kind: 'read' as const, label: '', detail: '' }
  const b = { kind: 'other' as const, label: '', detail: '' }
  d.see({ type: 'tool', tool: a })
  assert.ok(task.drafting, '第二个还在写：「正在写」留着')
  d.see({ type: 'tool', tool: b })
  assert.equal(task.drafting, undefined)
  const ga = (a as { genMs?: number }).genMs ?? -1
  const gb = (b as { genMs?: number }).genMs ?? -1
  assert.ok(ga >= 25 && ga < 60, `第一个只算到第二个开始写：${ga}`)
  assert.ok(gb >= 55, `第二个算到调用到了：${gb}`)
  d.see({ type: 'gen', text: '', tool: 'Write' })
  d.see({ type: 'text_delta', text: '好' })
  const c = { kind: 'edit' as const, label: '', detail: '' }
  d.see({ type: 'tool', tool: c })
  assert.equal((c as { genMs?: number }).genMs, undefined, '中间说了话的作废，不认领')
})
