/**
 * 启动迁移：崩溃留在盘上的「在用」标记（working / awaitingUser / prewarming）要清掉，
 * 不然清理和保活上限会一直把这些对话当成在用。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { Task } from '../../shared/schema.ts'
import { migrateOnStart } from './startup.ts'

setLang('zh')
const at = '2026-10-01T00:00:00.000Z'
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({ id, projectId: '', title: id, mode: 'chat', status: 'done', createdAt: at, updatedAt: at, ...extra })

function memStore(list: Task[]) {
  const map = new Map(list.map((x) => [x.id, structuredClone(x)]))
  return {
    map,
    list: async () => [...map.values()].map((x) => structuredClone(x)),
    get: async (id: string) => structuredClone(map.get(id) ?? null),
    update: async (id: string, tk: Task) => {
      map.set(id, structuredClone(tk))
      return tk
    },
  }
}

test('migrateOnStart：没在跑的对话上残留的 working / awaitingUser / prewarming 全部清掉，不动状态', async () => {
  const store = memStore([
    task('a', { awaitingUser: true }),
    task('w', { working: true }),
    task('p', { prewarming: true, status: 'stopped' }),
    task('clean'),
  ])
  await migrateOnStart(store)
  for (const id of ['a', 'w', 'p']) {
    const tk = store.map.get(id)!
    assert.equal(tk.working, false, id)
    assert.equal(tk.awaitingUser, false, id)
    assert.equal(tk.prewarming, false, id)
  }
  assert.equal(store.map.get('a')!.status, 'done', '只清标记，不把做完的改成别的状态')
  assert.equal(store.map.get('p')!.status, 'stopped')
})
