/**
 * 模型在写工具调用的入参时记「正在写」（drafting.ts）：开始写就记，调用到了、开始说话、这一轮结束就去掉。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task } from '../../shared/schema.ts'
import { createDrafting } from './drafting.ts'

test('开始写工具调用时记下，调用到了就去掉；不带工具名的生成不动它', () => {
  const task: Pick<Task, 'drafting'> = {}
  let n = 0
  const d = createDrafting(task, () => n++)
  // 读的时候别让 TS 按上一句断言收窄（see 会改它）
  const cur = () => task.drafting
  d.see({ type: 'gen', text: '{"pha' })
  assert.equal(task.drafting, undefined)
  d.see({ type: 'gen', text: '', tool: 'mcp__panel__submit_diagnosis' })
  assert.equal(cur()?.tool, 'mcp__panel__submit_diagnosis')
  d.see({ type: 'gen', text: 'se":"plan"' })
  d.see({ type: 'usage', addOutput: 3 })
  assert.ok(cur(), '写入参、用量这些事件不打断')
  d.see({ type: 'tool', tool: { kind: 'other', label: '', detail: '' } })
  assert.equal(cur(), undefined)
  d.see({ type: 'gen', text: '', tool: 'Write' })
  d.clear()
  assert.equal(cur(), undefined, '这一轮结束（进程退出）也去掉')
  assert.equal(n, 4)
})
