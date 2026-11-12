/**
 * 全局事件流（server/tasks/page-feed.ts）：连上先给全部顶层对话的 live，之后只推变了的；
 * 列表指纹变了推 `tasks`；页面都断开后定时器停掉，不再空转。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createTaskFeed } from './page-feed.ts'

const flush = () => new Promise((r) => setImmediate(r))

test('全局事件流：首包全量 live，之后只推变化；列表变了推 tasks；断开后不再推', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const tasks = [
      { id: 'a', title: 'A', status: 'running', updatedAt: '1' },
      { id: 'b', title: 'B', status: 'done', updatedAt: '1' },
      { id: 'c', title: 'C', status: 'running', updatedAt: '1', parentTaskId: 'a' },
    ]
    const lives: Record<string, { state: string }> = { a: { state: 'running' }, b: { state: 'done' } }
    const scope = {
      store: { list: async () => tasks },
      live: new Map(),
      liveOf: async (t: { id: string }) => lives[t.id],
    }
    const feed = createTaskFeed(scope as never)
    const got: [string, unknown][] = []
    const detach = await feed(async (e, d) => void got.push([e, d]))
    // 子对话不在全局流里，只给顶层对话
    assert.deepEqual(got, [['live', { a: { state: 'running' }, b: { state: 'done' } }]])

    got.length = 0
    lives.a = { state: 'idle' }
    mock.timers.tick(1000)
    await flush()
    assert.deepEqual(got, [['live', { a: { state: 'idle' } }]], '只推变了的那个')

    got.length = 0
    tasks[1].title = 'B2'
    mock.timers.tick(1000)
    await flush()
    assert.deepEqual(got, [['tasks', {}]], '列表变了让页面重新拉列表')

    got.length = 0
    detach()
    lives.b = { state: 'idle' }
    mock.timers.tick(5000)
    await flush()
    assert.deepEqual(got, [], '都断开后不再比较、不再推')
  } finally {
    mock.timers.reset()
  }
})
