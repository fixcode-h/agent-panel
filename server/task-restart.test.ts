/**
 * 面板重启后的状态回收：重启前还在跑的、以及「这一轮说完了但计划没做完 / 独立分支还没合回」的任务，
 * CLI 进程早已回收，界面不能继续画成在跑（childIcon 是 running 的那种转圈）。
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

// 记录写在临时数据目录，别碰本机的；必须在 import server 模块之前指过去
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-restart-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const at = '2026-10-01T00:00:00.000Z'

/** 一条合法的任务记录：用例只关心和重启迁移有关的字段 */
const task = (id: string, extra: Record<string, unknown>) =>
  Task.parse({
    id,
    projectId: '',
    title: id,
    mode: 'chat',
    status: 'done',
    createdAt: at,
    updatedAt: at,
    messages: [
      { id: 'u1', role: 'user', agentId: '', step: '', text: '把这几件事做完', tools: [], at },
      { id: 'a1', role: 'agent', agentId: '', step: '', text: '先做到这里', tools: [], at },
    ],
    ...extra,
  })

/** 8 步的计划，做完 6 步：openPlan 有值时界面画成在跑（见 childIcon 的 unfinished） */
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

/** 同一份计划，步骤全做完 */
const donePlan = () => ({ ...halfPlan(), doneAt: at, steps: halfPlan().steps.map((s) => ({ ...s, status: 'done' })) })

/** 同一条任务在子对话列表里会不会转圈：和界面用同一份判定，cliAlive 取重启后的值（进程没了） */
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
    unmerged: t.worktree?.state === 'active',
    wrapup: !!t.wrapRequest && t.wrapRequest.state !== 'failed',
    stopReason: t.stopReason,
  })

/** 按面板启动的流程跑一次迁移：落盘 → 新建 tasksApi（内部 ready）→ 读回 */
async function afterRestart(t: Task): Promise<Task> {
  await createTaskStore().create(t)
  const api = tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty })
  await api.ready()
  const back = await api.get(t.id)
  assert.ok(back, '任务还在')
  return back
}

test('重启前这一轮还在跑的任务：落成已停止，节点标成被打断', async () => {
  const t = task('running-turn', {
    status: 'running',
    working: true,
    steps: [{ id: 'st1', title: '跑测试', status: 'running' }],
  })
  const back = await afterRestart(t)
  assert.equal(back.status, 'stopped')
  assert.equal(back.stopReason, 'restart', '不是用户按的暂停')
  assert.equal(back.working, false)
  assert.equal(spins(back), false, '界面不能再转圈')
  assert.equal(back.steps[0].status, 'pending')
  assert.equal(back.steps[0].interrupted, true)
})

test('这一轮说完了但计划没做完的子对话：重启后落成已停止，不再显示在跑', async () => {
  const t = task('half-plan', { status: 'done', plans: [halfPlan()] })
  assert.equal(spins(t), true, '重启前它本来画成在跑（unfinished）')
  const back = await afterRestart(t)
  assert.equal(back.status, 'stopped', '计划没做完的任务重启后没人会接着做，不能继续显示执行中')
  assert.equal(back.stopReason, 'restart')
  assert.equal(spins(back), false, '图标、分组、计数一起变静止')
  assert.equal(
    childIcon({
      id: '',
      title: '',
      status: back.status,
      working: false,
      cliAlive: false,
      startedAt: at,
      stopReason: back.stopReason,
    }),
    'idle',
    '不是用户按的暂停',
  )
})

test('独立分支还没合回的子对话：重启后也落成已停止', async () => {
  const t = task('unmerged-branch', {
    status: 'done',
    plans: [{ ...donePlan(), id: 'p2' }],
    worktree: { state: 'active', branch: 'agent-panel/x', path: '', baseBranch: 'dev', note: '' },
  })
  const back = await afterRestart(t)
  assert.equal(back.status, 'stopped')
  assert.equal(back.stopReason, 'restart')
  assert.equal(spins(back), false, '分支还在，但重启后没人接着做，不能再画成执行中')
  assert.equal(back.worktree?.state, 'active', '分支记录不动，继续时还要用它')
})

test('彻底做完的任务保持已完成', async () => {
  const t = task('finished', { status: 'done', plans: [{ ...donePlan(), id: 'p3' }] })
  const back = await afterRestart(t)
  assert.equal(back.status, 'done')
  assert.equal(back.stopReason, undefined)
})

test('已经请父对话收尾的任务保留待收尾：它等的是父对话合并，不靠 CLI 进程', async () => {
  const t = task('wrapup', {
    status: 'done',
    plans: [halfPlan()],
    wrapRequest: { state: 'requested', at, note: '做完了', tests: 'npm run test:unit 通过', info: '' },
  })
  const back = await afterRestart(t)
  assert.equal(back.status, 'done')
  assert.equal(back.wrapRequest?.state, 'requested', '收尾请求不能丢')
})
