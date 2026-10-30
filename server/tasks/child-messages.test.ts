/**
 * 子对话状态交给父对话（noteParent）：什么时候叫起父对话、什么时候只记进收件箱。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { bindWait, ensureChildStep } from '../../shared/plan.ts'
import { Task, type StopReason } from '../../shared/schema.ts'
import { createChildMessages } from './child-messages.ts'
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

test('父对话这一轮已答完时被用户停下（记成 done）：跟着停下的子对话上报中断，不把父对话叫起来', async () => {
  const kid = task('kid', 'root', 'stopped', 'parent')
  const r = rig(task('root', '', 'done'), kid)
  await report(r, kid)
  assert.deepEqual(r.woke, [])
  // 上报没丢：记进收件箱，用户继续时一起处理
  assert.equal(r.map.get('root')!.inbox.length, 1)
})

test('子对话自己被停下（不是跟着父对话）：计划在等它，照旧叫起父对话处理', async () => {
  const kid = task('kid', 'root', 'stopped', 'user')
  const r = rig(task('root', '', 'done'), kid)
  await report(r, kid)
  assert.deepEqual(r.woke, ['root'])
})
