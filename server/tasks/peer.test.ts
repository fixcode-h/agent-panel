/**
 * 子对话交给父对话的消息（server/tasks/peer.ts 的 messageParent）：请父对话安排修复时什么情况叫醒父对话。
 * 子对话挂着「等父对话」那一步后，自己一轮结束不再上报、面板也不推，请求本身不叫醒父对话就成了父子互等
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { Task, type StopReason } from '../../shared/schema.ts'
import { createPeer } from './peer.ts'
import type { TasksScope } from './scope.ts'

setLang('zh')
const at = '2026-10-30T00:00:00.000Z'
const task = (id: string, parentTaskId: string, status: Task['status'], stopReason?: StopReason, extra = {}) =>
  Task.parse({
    id,
    projectId: 'p',
    parentTaskId,
    title: id,
    mode: 'chat',
    status,
    stopReason,
    createdAt: at,
    updatedAt: at,
    ...extra,
  })

function rig(parent: Task, kid: Task, live: Map<string, unknown> = new Map()) {
  const map = new Map([parent, kid].map((x) => [x.id, x]))
  const woke: { id: string; text: string }[] = []
  const s = {
    live,
    store: {
      get: async (id: string) => map.get(id) ?? null,
      update: async (id: string, tk: Task) => void map.set(id, tk),
    },
    peerOf: async () => undefined,
    wakeConv: async (id: string, text: string) => void woke.push({ id, text }),
    alertOn: () => () => {},
  } as unknown as TasksScope
  return { ...createPeer(s), map, woke }
}

const FIX = '【报错不是我改出来的，请安排修复后通知我】\nsrc/a.ts(3): TS2322'

test('请父对话安排修复：父对话空闲就叫醒它，消息和收件箱都带子对话 id；带了提问标记也不被并进阶段汇报', async () => {
  const kid = task('kid', 'root', 'running', undefined, { askUser: true })
  const r = rig(task('root', '', 'done', undefined, { askUser: true }), kid)
  const out = await r.messageParent(kid, FIX, false)
  assert.equal(r.woke.length, 1)
  assert.match(r.woke[0].text, /id: kid/)
  const root = r.map.get('root')!
  assert.match(root.inbox[0].text, /TS2322[\s\S]*id: kid/)
  assert.equal(root.messages.at(-1)!.panel, 'child')
  assert.match(out.info, /叫起它安排修复/)
  assert.equal(kid.pendingReport, undefined)

  // 子对话自己的「提问」关着、调用时又带了 question：以前会被并进 pendingReport，永远交不出去
  const quiet = task('kid', 'root', 'running', undefined, { askUser: false })
  const r2 = rig(task('root', '', 'done', undefined, { askUser: true }), quiet)
  await r2.messageParent(quiet, FIX, true, ['a', 'b'])
  assert.equal(r2.woke.length, 1)
  assert.equal(quiet.pendingReport, undefined)
  assert.equal(quiet.parentAsks?.length ?? 0, 0)
  assert.equal(r2.map.get('root')!.messages.filter((m) => m.panel === 'ask').length, 0)

  // 闲置回收停下的父对话不是用户让它停的：照样叫
  const r3 = rig(task('root', '', 'stopped', 'idle' as StopReason), task('kid', 'root', 'running'))
  await r3.messageParent(r3.map.get('kid')!, FIX, false)
  assert.equal(r3.woke.length, 1)

  // 普通阶段汇报照旧只记进本轮汇报，不叫
  const plain = task('kid', 'root', 'running', undefined, { askUser: true })
  const r4 = rig(task('root', '', 'done'), plain)
  await r4.messageParent(plain, '做完了第一步', false)
  assert.deepEqual(r4.woke, [])
  assert.equal(plain.pendingReport, '做完了第一步')
})

test('用户亲手停下的父对话不叫醒：已落盘的、刚按停止执行位还在的、子对话跟着父对话停下途中发的，提问关着的自动作答也一样', async () => {
  const kid = () => task('kid', 'root', 'running', undefined, { askUser: true })
  const stopped = rig(task('root', '', 'stopped', 'user'), kid())
  const out = await stopped.messageParent(stopped.map.get('kid')!, FIX, false)
  assert.deepEqual(stopped.woke, [])
  assert.equal(stopped.map.get('root')!.inbox.length, 1, '记进收件箱，用户点继续时一起处理')
  assert.match(out.info, /被用户停下/)

  const parent = task('root', '', 'running')
  const pressing = rig(parent, kid(), new Map([['root', { task: parent, stop: true, stopReason: 'user', rev: 0 }]]))
  await pressing.messageParent(pressing.map.get('kid')!, FIX, false)
  assert.deepEqual(pressing.woke, [])

  const k = kid()
  const closing = rig(
    task('root', '', 'done'),
    k,
    new Map([['kid', { task: k, stop: true, stopReason: 'parent', rev: 0 }]]),
  )
  await closing.messageParent(k, FIX, false)
  assert.deepEqual(closing.woke, [])

  const ask = rig(task('root', '', 'stopped', 'user', { askUser: false }), kid())
  await ask.messageParent(ask.map.get('kid')!, '选哪个？', true, ['A', 'B'])
  assert.deepEqual(ask.woke, [])
})
