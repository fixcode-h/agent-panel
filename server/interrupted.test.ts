import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 记录写在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-interrupted-'))
process.env.AGENT_PANEL_DATA = dir

const { acknowledgeInterrupted, interruptedApi, readInterrupted, recordInterrupted, resolveInterrupted } =
  await import('./interrupted.ts')
type Task = import('../shared/schema.ts').Task

const file = path.join(dir, 'cache', 'interrupted-by-update.json')

/** 只要 resolveInterrupted 用到的字段 */
const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    title: `任务 ${id}`,
    projectId: '',
    status: 'stopped',
    messages: [],
    steps: [],
    ...extra,
  }) as unknown as Task

test('记下被打断的任务，读回来带上时间和「还没处理」', async () => {
  await recordInterrupted([
    { id: 't1', doing: '分析需求' },
    { id: 't2', doing: '' },
  ])
  const r = await readInterrupted()
  assert.ok(r.at, '记下时间')
  assert.equal(r.acknowledged, false)
  assert.deepEqual(r.tasks, [
    { id: 't1', doing: '分析需求' },
    { id: 't2', doing: '' },
  ])
  // 新版本启动后从数据目录读，重启、换进程都还在
  assert.ok(readFileSync(file, 'utf8').includes('t1'))
})

test('没有任务时不动上一次的记录', async () => {
  await recordInterrupted([])
  assert.deepEqual(
    (await readInterrupted()).tasks.map((x) => x.id),
    ['t1', 't2'],
  )
  // 再次强制更新时覆盖上一次的
  await recordInterrupted([{ id: 't3', doing: '跑测试' }])
  assert.deepEqual(
    (await readInterrupted()).tasks.map((x) => x.id),
    ['t3'],
  )
})

test('处理过之后标记成已确认，记录留着', async () => {
  await acknowledgeInterrupted()
  const r = await readInterrupted()
  assert.equal(r.acknowledged, true)
  assert.deepEqual(
    r.tasks.map((x) => x.id),
    ['t3'],
  )
})

test('列出来之前过滤掉不能继续的任务：删掉的、归档的、导入的、已经跑完的', async () => {
  await recordInterrupted([
    { id: 'ok', doing: '正在写文档' },
    { id: 'gone', doing: '' },
    { id: 'archived', doing: '' },
    { id: 'imported', doing: '' },
    { id: 'done', doing: '' },
    { id: 'running', doing: '' },
  ])
  const all: Record<string, Task> = {
    ok: task('ok', { projectId: 'p1', messages: [{ role: 'user', text: '原来的要求' }] }),
    archived: task('archived', { archived: true }),
    imported: task('imported', { imported: { at: '', exportedAt: '', agents: [] } }),
    done: task('done', { status: 'done' }),
    running: task('running', { status: 'running' }),
  }
  const list = await resolveInterrupted(
    await readInterrupted(),
    async (id) => all[id] ?? null,
    async (id) => (id === 'p1' ? '演示项目' : ''),
  )
  assert.deepEqual(list, [
    { id: 'ok', title: '任务 ok', projectId: 'p1', projectName: '演示项目', doing: '正在写文档' },
  ])
})

test('没记下在做什么时用最后一条要求', async () => {
  await recordInterrupted([{ id: 'a', doing: '' }])
  const list = await resolveInterrupted(
    await readInterrupted(),
    async () =>
      task('a', {
        messages: [
          { role: 'user', text: '第一句' },
          { role: 'user', text: '接着把剩下的写完\n第二行不要' },
        ],
      }),
    async () => '',
  )
  assert.equal(list[0].doing, '接着把剩下的写完')
})

test('接口：读到列表，确认后 acknowledged 变成 true', async () => {
  await recordInterrupted([{ id: 'x', doing: '编译' }])
  const api = interruptedApi({
    ready: async () => {},
    getTask: async (id) => (id === 'x' ? task('x') : null),
    projectName: async () => '',
  })
  const get = await api.request('/interrupted')
  const body = (await get.json()) as { acknowledged: boolean; tasks: { id: string }[] }
  assert.equal(body.acknowledged, false)
  assert.deepEqual(
    body.tasks.map((x) => x.id),
    ['x'],
  )
  const ack = await api.request('/interrupted/ack', { method: 'POST' })
  assert.equal(((await ack.json()) as { acknowledged: boolean }).acknowledged, true)
})
