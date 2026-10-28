import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskMessage } from './schema.ts'
import { LITE_HEAD, autoArchivePicks, liteMessages } from './task.ts'

const msg = (id: string, output: string): TaskMessage =>
  ({
    id,
    role: 'agent',
    agentId: '',
    step: '',
    text: id,
    at: '',
    tools: [{ kind: 'run', label: 'ls', detail: '', output }],
  }) as TaskMessage

test('推给页面的消息：更早的长工具输出只留开头并记下原长，最近的和短的原样', () => {
  const long = 'a\n'.repeat(3000)
  const msgs = [msg('old', long), msg('short', 'ok'), msg('new', long)]
  const lite = liteMessages(msgs, 1)
  assert.equal(lite.length, 3)
  assert.equal(lite[0].tools[0].output?.length, LITE_HEAD)
  assert.deepEqual(lite[0].tools[0].outputCut, { len: long.length, lines: 3001, msg: 'old', i: 0 })
  assert.equal(lite[1], msgs[1], '短输出原样（同一个对象）')
  assert.equal(lite[2], msgs[2], '最近的原样')
  assert.equal(msgs[0].tools[0].output, long, '不改原来的消息')
})

test('自动归档：父子都很久没动、没在跑、回复看过了才归档；0 天不归档', () => {
  const now = Date.parse('2026-10-24T00:00:00Z')
  const old = '2026-08-01T00:00:00Z'
  const base = {
    archived: false,
    imported: false,
    status: 'done',
    working: false,
    requests: [],
    turnDoneAt: 'x',
    turnSeenAt: 'x',
  }
  const list = [
    { ...base, id: 'a', parentTaskId: '', updatedAt: old },
    { ...base, id: 'b', parentTaskId: '', updatedAt: old },
    { ...base, id: 'b1', parentTaskId: 'b', updatedAt: '2026-10-23T00:00:00Z' },
    { ...base, id: 'c', parentTaskId: '', updatedAt: old, turnSeenAt: '' },
    { ...base, id: 'd', parentTaskId: '', updatedAt: old },
    { ...base, id: 'e', parentTaskId: '', updatedAt: old, archived: true },
  ] as never[]
  assert.deepEqual(
    autoArchivePicks(list, 30, now, (id) => id === 'd'),
    ['a'],
  )
  assert.deepEqual(
    autoArchivePicks(list, 0, now, () => false),
    [],
  )
})
