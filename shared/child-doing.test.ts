/**
 * 父对话里子对话那一行的补充信息：最后一次工具调用（分析稿 U5）、Bug 走到第几步（U8）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { childBugStep, lastToolCall } from './child-doing.ts'
import { Task } from './schema.ts'

const at = '2026-11-10T08:00:00.000Z'
const task = (extra: Record<string, unknown> = {}) =>
  Task.parse({
    id: 'k',
    projectId: 'p',
    title: 'k',
    mode: 'chat',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    ...extra,
  })
const msg = (role: string, tools: { kind: string; label: string }[] = [], extra: Record<string, unknown> = {}) => ({
  id: `${role}-${Math.random()}`,
  role,
  text: '我先看了相关代码。',
  at,
  tools: tools.map((x) => ({ ...x, detail: '' })),
  ...extra,
})

test('最后一次工具调用：取子对话自己最近的一次，开口说话之后照样能拿到', () => {
  const tk = task({
    messages: [
      msg('user'),
      msg('agent', [
        { kind: 'read', label: 'web/src/a.ts' },
        { kind: 'edit', label: 'web/src/lib/store.ts' },
      ]),
      // 后面一段只说了话、没有调用工具：仍按上一段最后那次调用说
      msg('agent'),
    ],
  })
  assert.deepEqual(lastToolCall(tk), { kind: 'edit', name: undefined, label: 'web/src/lib/store.ts' })
})

test('最后一次工具调用：压缩上下文不算、工作流节点里的不算、用户又说了一句之后不再拿上一件事的', () => {
  const compact = task({
    messages: [
      msg('agent', [
        { kind: 'run', label: 'npm test' },
        { kind: 'compact', label: '压缩上下文' },
      ]),
    ],
  })
  assert.equal(lastToolCall(compact)?.label, 'npm test')
  const step = task({ messages: [msg('agent', [{ kind: 'run', label: 'npm test' }], { step: 'n1' })] })
  assert.equal(lastToolCall(step), undefined)
  const asked = task({ messages: [msg('agent', [{ kind: 'run', label: 'npm test' }]), msg('user')] })
  assert.equal(lastToolCall(asked), undefined)
})

test('Bug 走到第几步：不是 Bug 时没有；还没交报告在论证（0）', () => {
  assert.equal(childBugStep(task()), undefined)
  assert.equal(childBugStep(task({ bug: { kind: 'report' } })), 0)
})
