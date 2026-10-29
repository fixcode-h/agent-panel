/**
 * 子任务卡在「执行中、没有输出」，点终止却说「已经结束了」：面板里已经没有在跑的它
 * （异常退出、面板重启、派它的那一轮已经收尾），终止要直接把它收口成已终止，不能一直转圈。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-helper-orphan-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask } = await import('../shared/task.ts')
const { blankStep } = await import('../shared/flow.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()

const make = (id: string, status: 'running' | 'pending' | 'done') =>
  store.create({
    ...newTask({ projectId: '', mode: 'chat', prompt: '查一下' } as never, undefined, '', id),
    id,
    steps: [
      {
        ...blankStep({
          id: '@chat/sub/h1',
          parentId: '@chat',
          slot: 'sub',
          kind: 'agent',
          title: '查资料',
          agentId: '',
        }),
        status,
        startedAt: status === 'pending' ? '' : '2026-10-29T10:00:00.000Z',
      },
    ],
  })

const stop = (id: string) =>
  api().routes.request(`/${id}/subtasks/stop`, { method: 'POST', body: JSON.stringify({ step: '@chat/sub/h1' }) })

test('终止没在跑的子任务：标着执行中 / 正在启动的收口成已终止并落盘，做完的照旧回「已经结束了」', async () => {
  await make('orphan-running', 'running')
  const res = await stop('orphan-running')
  assert.equal(res.status, 200)
  const back = (await res.json()) as { steps: { status: string; endedAt: string }[] }
  assert.equal(back.steps[0].status, 'skipped')
  assert.ok(back.steps[0].endedAt)
  assert.equal((await createTaskStore().get('orphan-running'))!.steps[0].status, 'skipped')

  await make('orphan-pending', 'pending')
  assert.equal((await stop('orphan-pending')).status, 200)
  assert.equal((await createTaskStore().get('orphan-pending'))!.steps[0].status, 'skipped')

  await make('helper-done', 'done')
  assert.equal((await stop('helper-done')).status, 409)
  assert.equal((await createTaskStore().get('helper-done'))!.steps[0].status, 'done', '结论不被改掉')
})
