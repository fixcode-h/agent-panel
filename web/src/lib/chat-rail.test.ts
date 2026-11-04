/** Chat 页右栏「生成的文件」：从改文件类工具调用里取，去重、失败的不算、只看 Agent 的消息 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskMessage } from '@shared/schema'
import { chatWrittenFiles } from '@/lib/chat-rail'

const msg = (role: 'user' | 'agent', tools: { kind: string; label: string; failed?: boolean }[]) =>
  ({ id: Math.random().toString(), role, agentId: '', step: '', text: '', at: '', tools }) as unknown as TaskMessage

test('写过、改过的文件按第一次出现的顺序列出，同一个文件只列一次', () => {
  const list = chatWrittenFiles([
    msg('agent', [
      { kind: 'read', label: 'README.md' },
      { kind: 'edit', label: 'report.md' },
    ]),
    msg('agent', [
      { kind: 'edit', label: 'chart.py' },
      { kind: 'edit', label: 'report.md' },
    ]),
  ])
  assert.deepEqual(list, ['report.md', 'chart.py'])
})

test('失败的改动和用户消息里的不算', () => {
  assert.deepEqual(
    chatWrittenFiles([
      msg('agent', [{ kind: 'edit', label: 'a.md', failed: true }]),
      msg('user', [{ kind: 'edit', label: 'b.md' }]),
    ]),
    [],
  )
})
