import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task } from '../../shared/schema.ts'
import { upgradeChildToBug, BUG_UPGRADE_HEAD } from './bug-upgrade.ts'
import { upgradeBugArg } from '../child-kind-fields.ts'

/** 父对话把已有子对话升级成用户报的 Bug（send_to_conversation 写 kind: "bug"，ADR 0057） */
function scope(tasks: Partial<Task>[], liveIds: string[] = []) {
  const store = new Map(tasks.map((t) => [t.id!, structuredClone(t) as Task]))
  const live = new Map(liveIds.map((id) => [id, { task: store.get(id)! }]))
  const saved: Task[] = []
  const sc = {
    live,
    store: {
      get: async (id: string) => store.get(id),
      update: async (_id: string, t: Task) => {
        saved.push(structuredClone(t))
        return t
      },
    },
  } as never
  return { sc, store, saved }
}

test('标成用户报的 Bug：有 submit_diagnosis、下一轮补带完整流程、级别写进档案，交过去的话带上说明', async () => {
  const { sc, saved } = scope([{ id: 'c', parentTaskId: 'p', title: '修角标' }])
  const r = await upgradeChildToBug(sc, 'p', 'c', '角标不刷新，用户要按 Bug 流程查', 'deep')
  assert.ok(r.ok)
  assert.ok(r.message.startsWith(BUG_UPGRADE_HEAD))
  assert.match(r.message, /角标不刷新/)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].bug, true)
  assert.equal(saved[0].bugMethodPending, true)
  assert.equal(saved[0].bugCase?.level, 'deep')
  // send_to_conversation 只有写了 kind: "bug" 才升级，级别写错的不带
  assert.equal(upgradeBugArg({}), undefined)
  assert.equal(upgradeBugArg({ kind: 'task' }), undefined)
  assert.deepEqual(upgradeBugArg({ kind: 'bug' }), {})
  assert.deepEqual(upgradeBugArg({ kind: 'bug', level: 'quick' }), { level: 'quick' })
  assert.deepEqual(upgradeBugArg({ kind: 'bug', level: 'huge' }), {})
})

test('在跑的以内存里那份为准；正在回复时拒绝，不改标记', async () => {
  const { sc, store, saved } = scope([{ id: 'c', parentTaskId: 'p', title: '修角标', working: true }], ['c'])
  const r = await upgradeChildToBug(sc, 'p', 'c', 'x')
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.info : '', /正在回复.*没有升级/)
  assert.equal(store.get('c')!.bug, undefined)
  assert.equal(saved.length, 0)
})

test('已经是 Bug 的原样交，不重复补流程；不是自己名下的子对话找不到', async () => {
  const { sc, saved } = scope([
    { id: 'c', parentTaskId: 'p', title: 'a', bug: true },
    { id: 'd', parentTaskId: 'q', title: 'b' },
  ])
  const r = await upgradeChildToBug(sc, 'p', 'c', '原话')
  assert.ok(r.ok && r.message === '原话')
  assert.equal(saved.length, 0)
  const other = await upgradeChildToBug(sc, 'p', 'd', '原话')
  assert.equal(other.ok, false)
})
