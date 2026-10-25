/**
 * 界面点后台命令行标题打开的窗口按 jobId 拉输出：路由要认自己的对话、不存在的编号给 404。
 * 「有输出 / 最终输出 / 跨 taskId 读不到」在 server/background.test.ts 里测（那里有可控的假进程）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-job-view-'))

const { tasksApi } = await import('./tasks.ts')
const { createTaskStore } = await import('./task-store.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
const make = async (id: string, over: Record<string, unknown> = {}) =>
  store.create({ ...newTask({ projectId: '', mode: 'chat', prompt: id } as never, undefined, '', id), id, ...over })

test('读一条后台命令：对话不存在、编号不存在都是 404', async () => {
  await make('jv1')
  const t = api()
  // 这个对话根本没有后台命令（真的跑一条要起进程，输出部分在 background.test.ts 测）
  const none = await t.routes.request('/jv1/jobs/no-such-job')
  assert.equal(none.status, 404)
  assert.match(((await none.json()) as { error: string }).error, /没有这条后台命令/)
  // 任务不存在时先报任务
  const missing = await t.routes.request('/nope/jobs/no-such-job')
  assert.equal(missing.status, 404)
  assert.match(((await missing.json()) as { error: string }).error, /任务不存在/)
})

test('跨对话读别人的后台命令：当不存在给 404，不泄露别的对话的命令', async () => {
  await make('jv2')
  await make('jv3')
  const t = api()
  // jv2 名下没有命令，jv3 拿自己的 id 去读别人的也读不到（同一条路由，归属判断在 background.view 里）
  assert.equal((await t.routes.request('/jv3/jobs/no-such-job')).status, 404)
  assert.equal((await t.routes.request('/jv2/jobs/no-such-job')).status, 404)
})
