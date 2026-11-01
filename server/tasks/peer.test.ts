/**
 * 子对话交给父对话的消息（server/tasks/peer.ts 的 messageParent）：请父对话安排修复时什么情况叫醒父对话。
 * 子对话挂着「等父对话」那一步后，自己一轮结束不再上报、面板也不推，请求本身不叫醒父对话就成了父子互等
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { Task, type StopReason } from '../../shared/schema.ts'
import { createBudget } from './budget.ts'
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

/** tokens：项目的 token 上限（0 不限）；peerOf：交给父对话途中要做的事（模拟这时父对话被拉起来） */
function rig(
  parent: Task,
  kid: Task,
  live: Map<string, unknown> = new Map(),
  { tokens = 0, peerOf = () => {} }: { tokens?: number; peerOf?: () => void } = {},
) {
  const map = new Map([parent, kid].map((x) => [x.id, x]))
  const woke: { id: string; text: string }[] = []
  const s = {
    live,
    store: {
      list: async () => [...map.values()],
      get: async (id: string) => map.get(id) ?? null,
      update: async (id: string, tk: Task) => void map.set(id, tk),
    },
    deps: { projects: { get: async () => ({ id: 'p', budget: { tokens, costUsd: 0 } }) } },
    peerOf: async () => void peerOf(),
    wakeConv: async (id: string, text: string) => void woke.push({ id, text }),
    alertOn: () => () => {},
  } as unknown as TasksScope
  s.holdWake = createBudget(s).holdWake
  return { ...createPeer(s), map, woke }
}

const FIX = '【报错不是我改出来的，请安排修复后通知我】\nsrc/a.ts(3): TS2322'

test('请父对话安排修复：父对话空闲就叫醒它，消息和收件箱都带子对话 id；带了提问标记也不被并进阶段汇报', async () => {
  const kid = task('kid', 'root', 'running', undefined, { askUser: true })
  const r = rig(task('root', '', 'done', undefined, { askUser: true }), kid)
  const out = await r.messageParent(kid, FIX, false)
  assert.equal(r.woke.length, 1)
  // 叫醒那句直接带上报错正文：只说「在收件箱里」的话，收件箱没写进去父对话就无从下手
  assert.match(r.woke[0].text, /id: kid[\s\S]*TS2322/)
  const root = r.map.get('root')!
  assert.match(root.inbox[0].text, /TS2322[\s\S]*id: kid/)
  assert.equal(root.messages.at(-1)!.panel, 'child')
  assert.match(out.info, /叫起它安排修复/)
  assert.equal(kid.pendingReport, undefined)
  // 定时核对发现父对话一直没回（叫醒在重启时丢了、那一轮没回它）：再提醒一次，从对话里找回当时的报错
  assert.equal(await r.remindParentFix(kid), true)
  assert.match(r.woke[1].text, /还在等你安排修复[\s\S]*TS2322/)
  assert.doesNotMatch(r.woke[1].text, /【报错不是我改出来的/)

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

  // 交给父对话途中它被别的子对话的上报拉起来（执行位出现，执行器拿的是一份拷贝）：收件箱写进执行位那一份，不写旧对象
  const live = new Map<string, { task: Task; stop: boolean; rev: number }>()
  const r5 = rig(task('root', '', 'done', undefined, { askUser: true }), task('kid', 'root', 'running'), live, {
    peerOf: () => live.set('root', { task: structuredClone(r5.map.get('root')!), stop: false, rev: 0 }),
  })
  await r5.messageParent(r5.map.get('kid')!, FIX, false)
  assert.equal(live.get('root')!.task.inbox.length, 1)

  // 普通阶段汇报照旧只记进本轮汇报，不叫
  const plain = task('kid', 'root', 'running', undefined, { askUser: true })
  const r4 = rig(task('root', '', 'done'), plain)
  await r4.messageParent(plain, '做完了第一步', false)
  assert.deepEqual(r4.woke, [])
  assert.equal(plain.pendingReport, '做完了第一步')
})

test('不叫醒父对话：用户亲手停下（落盘的、刚按停止的）、用量上限停下、核对收成已中断、整棵树已超限、子对话自己正在停，提问关着的自动作答也一样', async () => {
  const kid = () => task('kid', 'root', 'running', undefined, { askUser: true })
  const stopped = rig(task('root', '', 'stopped', 'user'), kid())
  const out = await stopped.messageParent(stopped.map.get('kid')!, FIX, false)
  assert.deepEqual(stopped.woke, [])
  assert.equal(stopped.map.get('root')!.inbox.length, 1, '记进收件箱，用户点继续时一起处理')
  assert.match(out.info, /被用户停下/)

  // 用量上限停下的、被核对收口的父对话，和空闲但整棵树已经用满的（checkBudget 不会把空闲的记成 budget）
  for (const [parent, tokens] of [
    [task('root', '', 'stopped', 'budget'), 0],
    [task('root', '', 'stopped', 'lost'), 0],
    [task('root', '', 'done', undefined, { usage: { inputTokens: 900, outputTokens: 200 } }), 1000],
  ] as const) {
    const r = rig(parent, kid(), new Map(), { tokens })
    await r.messageParent(r.map.get('kid')!, FIX, false)
    assert.deepEqual(r.woke, [], `${parent.status}/${parent.stopReason}`)
    assert.equal(r.map.get('root')!.inbox.length, 1)
  }

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
  const k2 = kid()
  const budget = rig(
    task('root', '', 'done'),
    k2,
    new Map([['kid', { task: k2, stop: true, stopReason: 'budget', rev: 0 }]]),
  )
  await budget.messageParent(k2, FIX, false)
  assert.deepEqual(budget.woke, [])

  const ask = rig(task('root', '', 'stopped', 'user', { askUser: false }), kid())
  await ask.messageParent(ask.map.get('kid')!, '选哪个？', true, ['A', 'B'])
  assert.deepEqual(ask.woke, [])
})
