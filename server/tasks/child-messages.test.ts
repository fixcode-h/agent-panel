/**
 * 子对话状态交给父对话（noteParent）：什么时候叫起父对话、什么时候只记进收件箱。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { bindWait, ensureChildStep } from '../../shared/plan.ts'
import { Task, type StopReason } from '../../shared/schema.ts'
import { createChildMessages, setSendWaitMs } from './child-messages.ts'
import type { TasksScope } from './scope.ts'

setLang('zh')
const at = '2026-10-30T00:00:00.000Z'
const task = (id: string, parentTaskId: string, status: Task['status'], stopReason?: StopReason) =>
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
  })

function rig(parent: Task, kid: Task) {
  // 父对话计划里有一步在等这个子对话
  const step = ensureChildStep(parent, kid.id, kid.title, at)!
  bindWait(parent, step, { kind: 'child', ref: kid.id, label: kid.title }, at)
  const map = new Map([parent, kid].map((x) => [x.id, x]))
  const woke: string[] = []
  const s = {
    live: new Map(),
    store: {
      get: async (id: string) => map.get(id) ?? null,
      update: async (id: string, tk: Task) => void map.set(id, tk),
    },
    planKids: async () => [],
    runningConv: () => undefined,
    wakeConv: async (id: string) => void woke.push(id),
    alertOn: () => () => {},
  } as unknown as TasksScope
  return { ...createChildMessages(s), map, woke }
}

const report = (r: ReturnType<typeof rig>, kid: Task) =>
  r.noteParent(
    'root',
    kid,
    '【子对话状态】已中断',
    undefined,
    { kind: 'child', ref: kid.id, ok: false },
    {
      id: kid.id,
      title: kid.title,
      state: 'stopped',
    },
  )

test('父对话这一轮已答完时被用户停下（记成 done）：跟着停下的子对话不报中断，只改计划（ADR 0034）', async () => {
  const kid = task('kid', 'root', 'stopped', 'parent')
  const r = rig(task('root', '', 'done'), kid)
  await report(r, kid)
  assert.deepEqual(r.woke, [])
  // 告诉父对话一件它自己做的事没有用：不写进对话流、不进收件箱，继续时由面板连带拉起
  const root = r.map.get('root')!
  assert.equal(root.inbox.length, 0)
  assert.equal(root.messages.length, 0)
  // 计划那一步照旧退回进行中，继续后等它的结果
  const step = root.plans.at(-1)!.steps.find((x) => x.waits.some((w) => w.ref === kid.id))!
  assert.notEqual(step.status, 'done')
})

test('同一个子对话的汇报父对话还没读：新的替换掉旧的，旧那行标成已被取代（ADR 0034）', async () => {
  const kid = task('kid', 'root', 'done')
  const other = task('other', 'root', 'done')
  const r = rig(task('root', '', 'stopped', 'user'), kid)
  const peer = (from: Task) => ({
    id: from.id,
    title: from.title,
    name: '',
    rel: 'child' as const,
    kind: 'report' as const,
    subject: '',
  })
  const send = (from: Task, text: string) =>
    r.noteParent(
      'root',
      from,
      text,
      undefined,
      undefined,
      { id: from.id, title: from.title, state: 'done' },
      peer(from),
    )
  await send(kid, '第一封')
  await send(other, '别的子对话')
  await send(kid, '第二封')
  const root = r.map.get('root')!
  assert.deepEqual(
    root.inbox.map((x) => x.text),
    ['别的子对话', '第二封'],
  )
  const first = root.messages.find((m) => m.text === '第一封')!
  assert.equal(first.peer?.superseded, true)
  assert.equal(root.messages.find((m) => m.text === '第二封')!.peer?.superseded, undefined)
})

test('子对话自己被停下（不是跟着父对话）：计划在等它，照旧叫起父对话处理', async () => {
  const kid = task('kid', 'root', 'stopped', 'user')
  const r = rig(task('root', '', 'done'), kid)
  await report(r, kid)
  assert.deepEqual(r.woke, ['root'])
})

test('父对话交给收尾中的子对话：子对话迟迟开不起来时限时回话，不让父对话的工具调用挂到超时', async () => {
  setSendWaitMs(30)
  try {
    const kid = task('kid', 'root', 'done')
    const parent = task('root', '', 'running')
    const map = new Map([parent, kid].map((x) => [x.id, x]))
    let finish: () => void = () => {}
    const s = {
      live: new Map(),
      store: { get: async (id: string) => map.get(id) ?? null, update: async () => {} },
      runningConv: () => undefined,
      peerOf: async () => undefined,
      // 子对话上一轮还在收尾：消息排着，等收尾结束才开新一轮
      wakeConv: () => new Promise<'held'>((r) => (finish = () => r('held'))),
      alertOn: () => () => {},
    } as unknown as TasksScope
    // 限时的定时器 unref 了：留一个定时器撑住事件循环，等它到点
    const hold = setTimeout(() => {}, 5000)
    const r = await createChildMessages(s).sendToChild('root', 'kid', '清理排查代码', undefined, 'task')
    clearTimeout(hold)
    assert.equal(r.ok, true)
    assert.match(r.info, /收尾完会自动开始处理/)
    finish()
  } finally {
    setSendWaitMs(40_000)
  }
})
