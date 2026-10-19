import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Workflow } from '../shared/schema.ts'
import { checkWorkflow, workflowDeleteError } from '../shared/validate.ts'
import {
  DEFAULT_WORKFLOW_ID,
  defaultWorkflow,
  handoffPrompt,
  parseNext,
  stripNext,
  taskSnapshot,
} from '../shared/builtin/default.ts'

const other = (id: string, name: string) => ({ ...defaultWorkflow(), id, name, description: `${name}的说明` })

test('默认工作流符合结构、能通过保存检查、不能删除', () => {
  const w = Workflow.parse(defaultWorkflow())
  assert.equal(w.id, DEFAULT_WORKFLOW_ID)
  assert.equal(checkWorkflow(w, new Set([w.mainAgentId]), [w], w.id), null)
  assert.ok(workflowDeleteError(DEFAULT_WORKFLOW_ID, [], []))
})

test('任务快照里默认工作流的说明附上用户已有的工作流，不含自己', () => {
  const all = [defaultWorkflow(), other('w1', '日常开发'), other('w2', 'Bug 修复')]
  const [snap] = taskSnapshot(all[0], all)
  assert.match(snap.document, /- id: w1｜日常开发/)
  assert.match(snap.document, /- id: w2｜Bug 修复/)
  assert.doesNotMatch(snap.document, new RegExp(`id: ${DEFAULT_WORKFLOW_ID}`))
  // 别的工作流不受影响
  assert.equal(taskSnapshot(all[1], all)[0].document, all[1].document)
})

test('解析推荐：只留存在的工作流，按名字也能认，去重、最多三个；坏 JSON 不报错', () => {
  const ws = [other('w1', '日常开发'), other('w2', 'Bug 修复'), other('w3', '文档'), other('w4', '评审')]
  const text =
    '结论……\n\n```next-workflows\n' +
    JSON.stringify([
      { id: 'w2', reason: '有 Bug', prompt: '修复登录' },
      { id: 'nope', reason: '不存在' },
      { id: '日常开发', reason: '按名字' },
      { id: 'w2' },
      { id: DEFAULT_WORKFLOW_ID },
      { id: 'w3' },
      { id: 'w4' },
    ]) +
    '\n```'
  const recs = parseNext(text, [...ws, defaultWorkflow()])
  assert.deepEqual(
    recs.map((r) => r.id),
    ['w2', 'w1', 'w3'],
  )
  assert.equal(recs[0].prompt, '修复登录')
  assert.deepEqual(parseNext('```next-workflows\n{坏的\n```', ws), [])
  assert.deepEqual(parseNext('没有推荐', ws), [])
})

test('显示时去掉推荐块，流式输出到一半也去掉', () => {
  assert.equal(stripNext('结论\n\n```next-workflows\n[]\n```'), '结论')
  assert.equal(stripNext('结论\n\n```next-workflows\n[{"id"'), '结论')
  assert.equal(stripNext('普通 ```ts\ncode\n```'), '普通 ```ts\ncode\n```')
})

test('交给下一个工作流的描述带上原始需求和结果，太长时截掉结果', () => {
  const p = handoffPrompt(
    { id: 'w1', reason: '理由', prompt: '修复登录' },
    '登录报错了',
    '分析：token 过期\n```next-workflows\n[]\n```',
  )
  assert.match(p, /^修复登录/)
  assert.match(p, /### 原始需求\n登录报错了/)
  assert.match(p, /### 分析结果\n分析：token 过期/)
  assert.doesNotMatch(p, /next-workflows/)
  const long = handoffPrompt({ id: 'w1', reason: '', prompt: '' }, '需求', 'x'.repeat(50000))
  assert.ok(long.length <= 20000)
  assert.match(long, /^需求/)
})
