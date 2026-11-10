import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirPeers, editedLately, type DirFacts } from './shared-dir.ts'

const user = { role: 'user', step: '', tools: [] }
const agent = (...kinds: string[]) => ({ role: 'agent', step: '', tools: kinds.map((kind) => ({ kind, label: 'x' })) })

test('最近改过文件：只看这一轮和上一轮的改文件调用和每轮改动，失败的调用、撤销过的改动、更早的不算', () => {
  assert.equal(editedLately([user, agent('read', 'edit')] as never), true)
  assert.equal(editedLately([user, agent('edit'), user, agent('run')] as never), true, '上一轮改过也算')
  assert.equal(editedLately([user, agent('edit'), user, agent('run'), user, agent('read')] as never), false)
  assert.equal(editedLately([user, agent('read', 'run')] as never), false, '只查资料、跑命令不算')
  const failed = { role: 'agent', step: '', tools: [{ kind: 'edit', label: 'x', failed: true }] }
  assert.equal(editedLately([user, failed] as never), false)
  const card = (revertedAt?: string) => ({
    role: 'agent',
    step: '',
    tools: [],
    turnChanges: { spans: [], files: [{ path: 'a.ts', add: 1, del: 0 }], revertedAt },
  })
  assert.equal(editedLately([user, card()] as never), true, '命令改的文件记在每轮改动上')
  assert.equal(editedLately([user, card('2026-01-01T00:00:00Z')] as never), false)
  // 子任务收到的要求（带 step）不算一轮的开头
  const brief = { role: 'user', step: 's1', tools: [] }
  assert.equal(editedLately([user, agent('edit'), brief, brief, agent('read')] as never), true)
})

test('要提醒的对话：同一个目录、正在动手、最近改过文件，而且不是一家的', () => {
  const me = { id: 'me', dir: '/p', root: 'me' }
  const peer = (id: string, over: Partial<DirFacts> = {}): DirFacts => ({
    id,
    title: id,
    dir: '/p',
    root: id,
    busy: true,
    edited: true,
    ...over,
  })
  const got = dirPeers(me, [
    peer('same'),
    peer('branch', { dir: '/wt/branch' }),
    peer('idle', { busy: false }),
    peer('reading', { edited: false }),
    peer('kid', { root: 'me' }),
    peer('me'),
  ])
  assert.deepEqual(got, [{ id: 'same', title: 'same' }])
  assert.deepEqual(dirPeers({ id: 'me', dir: '', root: 'me' }, [peer('same', { dir: '' })]), [], '没有目录的不比')
})
