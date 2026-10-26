/**
 * 进程回收后的状态收口：落盘里还写着「等下一句」（running）的任务，页面宽限到了回收时不能继续留着 running，
 * 否则列表一直转圈、还算进「N 个执行中」，而「继续」按钮只在 stopped 时出现（用户报的现象）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../shared/i18n.ts'
import { openPlan } from '../shared/plan.ts'
import { Task } from '../shared/schema.ts'
import { childIcon, childSpinning } from '../shared/task.ts'

// 任务记录写在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-reclaim-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')
const { settleReclaimed } = await import('./exec/reclaim.ts')

setLang('zh')
const at = '2026-10-01T00:00:00.000Z'

/** 8 步的计划做完 6 步：openPlan 有值时界面按 childIcon 画成在跑 */
const halfPlan = () => ({
  id: 'p1',
  title: '',
  createdAt: at,
  doneAt: '',
  steps: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i + 1}`,
    title: `第 ${i + 1} 步`,
    status: i < 6 ? 'done' : 'pending',
  })),
})

const task = (id: string, extra: Record<string, unknown>) =>
  Task.parse({
    id,
    projectId: '',
    title: id,
    mode: 'chat',
    status: 'done',
    createdAt: at,
    updatedAt: at,
    messages: [{ id: 'u1', role: 'user', agentId: '', step: '', text: '把这几件事做完', tools: [], at }],
    ...extra,
  })

/** 任务在子对话列表里会不会转圈：和界面用同一份判定，cliAlive 取进程已回收的值 */
const spins = (t: Task) =>
  childSpinning({
    id: t.id,
    title: t.title,
    status: t.status,
    working: t.working,
    cliAlive: false,
    startedAt: t.createdAt,
    requests: t.requests.length,
    asking: t.parentAsks?.length ?? 0,
    resolved: t.resolved === true,
    plan: openPlan(t),
    stopReason: t.stopReason,
  })

test('进程已回收、状态还写着 running 的等下一句任务：收口成已停止，不再显示在跑', async () => {
  const store = createTaskStore()
  // 这一轮跑完、CLI 留着等下一句：status 还是 running、working 是 false、计划 6/8
  const waiting = task('reclaimed-wait', {
    status: 'running',
    working: false,
    plans: [halfPlan()],
    steps: [{ id: 'st1', title: '跑测试', status: 'running' }],
  })
  const created = await store.create(waiting)
  const savedAt = created.updatedAt
  assert.equal(spins(waiting), true, '回收前界面把它画成在跑（等下一句 + 计划没做完）')

  assert.equal(await settleReclaimed(store, waiting.id, 'presence'), true)

  const back = await createTaskStore().get(waiting.id)
  assert.ok(back)
  assert.equal(back.status, 'stopped', '进程回收后不能还写着 running：界面会一直转圈、也没有「继续」入口')
  assert.equal(back.stopReason, 'presence', '是页面宽限回收的，不是用户按的暂停')
  assert.equal(back.working, false)
  assert.equal(back.updatedAt, savedAt, '回收不是「刚有活动」：列表时间和排序不能往前跳')
  assert.equal(back.steps[0].status, 'pending', '还在跑的步骤要结掉，否则计划里那一行继续画成在做')
  assert.equal(back.steps[0].interrupted, true)
  assert.equal(spins(back), false, '图标、分组、计数一起变静止')
  assert.equal(
    childIcon({
      id: back.id,
      title: back.title,
      status: back.status,
      working: false,
      cliAlive: false,
      startedAt: at,
      stopReason: back.stopReason,
    }),
    'idle',
  )
})

test('这一轮真的在执行（working）的任务不碰', async () => {
  const store = createTaskStore()
  const running = task('still-working', { status: 'running', working: true })
  await store.create(running)
  assert.equal(await settleReclaimed(store, running.id, 'presence'), false)
  const back = await createTaskStore().get(running.id)
  assert.equal(back?.status, 'running', '还在产出的任务不能被回收收口')
  assert.equal(back?.working, true)
})

test('已经停下的任务不覆盖原来的停止原因', async () => {
  const store = createTaskStore()
  const stopped = task('user-stopped', { status: 'stopped', stopReason: 'user' })
  await store.create(stopped)
  assert.equal(await settleReclaimed(store, stopped.id, 'presence'), false)
  const back = await createTaskStore().get(stopped.id)
  assert.equal(back?.stopReason, 'user', '用户按的暂停不能被改成「页面切走后结束」')
})

test('这一轮已经说完（done）、但计划没做完：回收时也收口成已停止，不再画成在跑', async () => {
  const store = createTaskStore()
  const doneUnfinished = task('done-unfinished', { status: 'done', plans: [halfPlan()] })
  await store.create(doneUnfinished)
  assert.equal(spins(doneUnfinished), true, 'done + 计划没做完，界面按 unfinished 画成在跑')

  assert.equal(await settleReclaimed(store, doneUnfinished.id, 'presence'), true)

  const back = await createTaskStore().get(doneUnfinished.id)
  assert.ok(back)
  assert.equal(back.status, 'stopped')
  assert.equal(back.stopReason, 'presence')
  assert.equal(spins(back), false)
})

test('一轮做完了、没有挂起事项：回收不改状态（预热退出不算中断）', async () => {
  const store = createTaskStore()
  const finished = task('finished-done', {
    status: 'done',
    plans: [{ ...halfPlan(), doneAt: at, steps: halfPlan().steps.map((s) => ({ ...s, status: 'done' })) }],
  })
  await store.create(finished)
  assert.equal(await settleReclaimed(store, finished.id, 'presence'), false)
  const back = await createTaskStore().get(finished.id)
  assert.equal(back?.status, 'done', '做完的任务切走回收后仍是 done')
})
