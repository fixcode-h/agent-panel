/**
 * 子对话先后依赖（server/tasks/after-deps.ts）：前置合回后启动排在后面的子对话，前置失败时不启动、只告诉父对话一次，
 * 父对话给在等的子对话交消息时马上开始。只用一个最小的假 scope，断言状态改写和调用。
 * 运行：npx tsx --test server/tasks/after-deps.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task as TaskT } from '../../shared/schema.ts'
import type { TasksScope } from './scope.ts'

const { Task } = await import('../../shared/schema.ts')
const { createAfterDeps } = await import('./after-deps.ts')

const at = '2026-11-11T00:00:00.000Z'
const task = (over: Record<string, unknown>) =>
  Task.parse({ projectId: 'p', mode: 'chat', status: 'done', createdAt: at, updatedAt: at, ...over })

function rig(tasks: TaskT[]) {
  const map = new Map(tasks.map((x) => [x.id, x]))
  const started: { id: string; message: string }[] = []
  const noted: { parent: string; body: string }[] = []
  const s = {
    live: new Map(),
    shuttingDown: false,
    store: {
      get: async (id: string) => structuredClone(map.get(id)) ?? null,
      childrenOf: async (id: string) =>
        [...map.values()].filter((x) => x.parentTaskId === id).map((x) => ({ ...structuredClone(x), messages: [] })),
      update: async (id: string, tk: TaskT) => void map.set(id, structuredClone(tk)),
    },
    deps: { projects: { get: async () => ({ id: 'p' }) }, agents: { list: async () => [] } },
    startChild: async (sub: TaskT, message: string) => void started.push({ id: sub.id, message }),
    noteParent: async (parent: string, _from: TaskT, body: string) => void noted.push({ parent, body }),
    peerOf: async (from: TaskT) => ({
      id: from.id,
      title: from.title,
      name: '',
      rel: 'parent',
      kind: 'task',
      subject: '',
    }),
    alertOn: () => () => undefined,
  } as unknown as TasksScope
  return { a: createAfterDeps(s), map, started, noted }
}

const parent = () => task({ id: 'P', title: '父对话' })
const kidA = (over: Record<string, unknown> = {}) =>
  task({ id: 'A', parentTaskId: 'P', title: '改接口', status: 'running', ...over })
const kidB = () =>
  task({
    id: 'B',
    parentTaskId: 'P',
    title: '改页面',
    status: 'stopped',
    stopReason: 'after',
    waitAfter: ['A'],
    messages: [{ id: 'u1', role: 'user', text: '页面接新接口', at }],
  })

test('前置还没合回时不启动；合回后启动，清掉等待，派单原样交给它', async () => {
  const x = rig([parent(), kidA(), kidB()])
  await x.a.releaseAfter('P')
  assert.deepEqual(x.started, [])
  x.map.set('A', kidA({ mergedAt: at, status: 'done' }))
  await x.a.releaseAfter('P')
  assert.deepEqual(x.started, [{ id: 'B', message: '页面接新接口' }])
  const b = x.map.get('B')!
  assert.equal(b.waitAfter, undefined)
  assert.equal(b.stopReason, undefined)
  assert.equal(b.status, 'running')
  // 写回的是完整记录，不是列表里截掉消息的那份
  assert.equal(b.messages.length, 1)
  // 再扫一遍不会启动第二次
  await x.a.releaseAfter('P')
  assert.equal(x.started.length, 1)
})

test('前置失败：不启动，告诉父对话一次；同一个失败不重复说', async () => {
  const x = rig([parent(), kidA({ status: 'failed' }), kidB()])
  await x.a.releaseAfter('P')
  await x.a.releaseAfter('P')
  assert.deepEqual(x.started, [])
  assert.equal(x.noted.length, 1)
  assert.equal(x.noted[0].parent, 'P')
  assert.match(x.noted[0].body, /【前置没合回】子对话「改页面」.*「改接口」执行失败了/)
  // 前置修好合回后照样自动开始
  x.map.set('A', kidA({ mergedAt: at, status: 'done' }))
  await x.a.releaseAfter('P')
  assert.equal(x.started.length, 1)
})

test('父对话给在等的子对话交消息：马上开始，补充的话跟在原派单后面', async () => {
  const x = rig([parent(), kidA(), kidB()])
  const r = await x.a.startAfterNow(parent(), x.map.get('B')!, '接口还没好，先用假数据')
  assert.equal(r.ok, true, r.info)
  assert.deepEqual(x.started, [{ id: 'B', message: '页面接新接口\n\n父对话补充：接口还没好，先用假数据' }])
  assert.equal(x.map.get('B')!.waitAfter, undefined)
  // 之后前置合回也不会再启动一次
  x.map.set('A', kidA({ mergedAt: at, status: 'done' }))
  await x.a.releaseAfter('P')
  assert.equal(x.started.length, 1)
})
