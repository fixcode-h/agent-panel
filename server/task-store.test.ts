import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-store-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')

const write = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data), 'utf8')
}

const base = (id: string, extra: Record<string, unknown>) => ({
  id,
  projectId: '',
  title: id,
  mode: 'chat',
  status: 'done',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
})

test('旧任务记录没有 turnSeenAt：当作看过，不亮成未读', async () => {
  const chats = path.join(dir, 'tasks', 'chats')
  const done = '2026-10-01T01:00:00.000Z'
  // 早期版本写出来的记录没有 turnSeenAt 这个键
  write(path.join(chats, 'old-done.json'), base('old-done', { turnDoneAt: done }))
  // 新版本写出来的记录带着 turnSeenAt，没看过就保持未读
  write(path.join(chats, 'new-unread.json'), base('new-unread', { turnDoneAt: done, turnSeenAt: '' }))

  const store = createTaskStore()
  const list = await store.list()
  assert.equal(list.find((t) => t.id === 'old-done')?.turnSeenAt, done, '旧记录补成已读')
  assert.equal(list.find((t) => t.id === 'new-unread')?.turnSeenAt, '', '新记录保持未读')
})
