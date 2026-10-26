import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisHome, analyzerId, rootIdOf } from './analysis-home.ts'

const conv = (o: Partial<{ id: string; projectId: string; parentTaskId: string; rootTaskId: string }> = {}) => ({
  id: 'p',
  projectId: 'proj',
  parentTaskId: '',
  rootTaskId: '',
  mode: 'chat' as const,
  imported: undefined,
  ...o,
})

test('分析归属：顶层对话的分析开成它自己的子对话', () => {
  const tk = conv()
  assert.deepEqual(analysisHome({ kind: 'task', task: tk }, tk), {
    projectId: 'proj',
    parentTaskId: 'p',
    place: 'child',
  })
  // 没传 root 时顶层对话自己就是 root
  assert.equal(analysisHome({ kind: 'task', task: tk }).parentTaskId, 'p')
})

test('分析归属：子对话（和子对话里的子任务）的分析开在父对话下，不在子对话下再开', () => {
  const root = conv()
  const child = conv({ id: 'c', parentTaskId: 'p', rootTaskId: 'p' })
  const home = analysisHome({ kind: 'task', task: child }, root)
  assert.equal(home.parentTaskId, 'p')
  assert.equal(home.place, 'child')
  // 旧数据没有 rootTaskId：按 parentTaskId 找
  assert.equal(rootIdOf({ ...child, rootTaskId: '' }), 'p')
})

test('分析归属：父对话挂不了子对话时退回项目对话', () => {
  const child = conv({ id: 'c', parentTaskId: 'p', rootTaskId: 'p' })
  // 不知道父对话是什么样：不冒险挂上去
  assert.deepEqual(analysisHome({ kind: 'task', task: child }), {
    projectId: 'proj',
    parentTaskId: '',
    place: 'project',
  })
  // 工作流执行、导入的只读记录
  const flow = { ...conv(), mode: 'workflow' as const }
  assert.equal(analysisHome({ kind: 'task', task: flow }, flow).place, 'project')
  const imported = { ...conv(), imported: { at: '', exportedAt: '', app: '', agents: [] } as never }
  assert.equal(analysisHome({ kind: 'task', task: imported }, imported).place, 'project')
  // root 不是它的顶层对话（传错了）也不挂
  assert.equal(analysisHome({ kind: 'task', task: child }, conv({ id: 'x' })).place, 'project')
})

test('分析归属：Chat 模式的对话、项目外的分析都开 Chat 对话', () => {
  const chat = conv({ projectId: '' })
  assert.equal(analysisHome({ kind: 'task', task: chat }, chat).place, 'chat')
  assert.equal(analysisHome({ kind: 'chat' }).place, 'chat')
  assert.deepEqual(analysisHome({ kind: 'project', projectId: 'proj' }), {
    projectId: 'proj',
    parentTaskId: '',
    place: 'project',
  })
  assert.equal(analysisHome({ kind: 'project', projectId: '' }).place, 'chat')
})

test('分析对话用必备角色「分析」，关掉或没装时不用角色', () => {
  assert.equal(analyzerId([{ id: 'a', origin: 'builtin:analyzer', enabled: true }]), 'a')
  assert.equal(analyzerId([{ id: 'a', origin: 'builtin:analyzer', enabled: false }]), '')
  assert.equal(analyzerId([{ id: 'w', origin: 'builtin:worker', enabled: true }]), '')
})
