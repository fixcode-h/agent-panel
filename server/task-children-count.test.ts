/**
 * 父对话名下的子对话计数（`childrenWorking` / `childrenCli`）：SSE 每秒都会问，
 * 改成一次遍历 + 1 秒共享缓存后，计数结果要和改前一致（缓存命中也不能算错）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-child-counts-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')
const { resetCaches } = await import('./store.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
const at = '2026-10-01T02:00:00.000Z'

const make = async (id: string, patch: Record<string, unknown>, parentTaskId = '') =>
  store.create({
    ...newTask({ projectId: '', mode: 'chat', prompt: id, parentTaskId } as never, undefined, at, id),
    id,
    title: id,
    ...patch,
  })

await make('count-parent', { status: 'done' })
await make('count-done', { status: 'done' }, 'count-parent')
await make('count-empty-parent', { status: 'done' })

const task = async (t: ReturnType<typeof api>, id: string) => {
  const res = await t.routes.request(`/${id}`)
  assert.equal(res.status, 200)
  return (await res.json()) as { childrenWorking?: number; childrenCli?: number }
}

test('名下没有在跑的子对话时是 0（子对话只是做完了）', async () => {
  const t = api()
  const got = await task(t, 'count-parent')
  assert.equal(got.childrenWorking, 0)
  assert.equal(got.childrenCli, 0)
})

test('子对话在跑时算进 childrenWorking；同一秒内再次请求（命中缓存）结果一致', async () => {
  // 先等 api 启动时的迁移做完，再写入「执行中」的子对话：迁移会把盘上执行中、内存里没有进程的任务落成已停止，
  // 以前先写再建 api，请求和迁移抢先后，CI 上偶发算成 0（出包的抖动报告拦过）。
  // 写完让各集合重新从文件读（和导入数据后同一个入口），api 才看得到迁移之后写的这一条
  const t = api()
  await t.ready()
  await make('count-running', { status: 'running', working: true }, 'count-parent')
  resetCaches()
  const first = await task(t, 'count-parent')
  assert.equal(first.childrenWorking, 1)
  const second = await task(t, 'count-parent')
  assert.equal(second.childrenWorking, 1, '缓存命中也必须是同一份结果')
  const other = await task(t, 'count-empty-parent')
  assert.equal(other.childrenWorking, 0, '别的父对话不会算到它的子对话')
})
