import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { z } from 'zod'

// 数据目录换成临时的，别动本机的设置和任务
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-store-concurrency-'))
process.env.AGENT_PANEL_DATA = dir

const { createCollection } = await import('./store.ts')

const Item = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

test('并发创建都写进文件，不会各自基于旧快照互相覆盖', async () => {
  const c = createCollection('concurrent-create.json', Item)
  await Promise.all(Array.from({ length: 20 }, (_, i) => c.create({ name: `item-${i}` })))

  const list = await c.list()
  assert.equal(list.length, 20)
  assert.equal(new Set(list.map((x) => x.name)).size, 20)

  const onDisk = JSON.parse(readFileSync(path.join(dir, 'concurrent-create.json'), 'utf8')) as unknown[]
  assert.equal(onDisk.length, 20, '落盘的条目数和内存里一致')
})

test('第一次读取和创建同时发生：创建出来的条目不会被旧快照覆盖', async () => {
  const c = createCollection('concurrent-first-read.json', Item)
  // 服务启动时的后台任务（安装内置工作流、迁移旧项目）会不 await 地读一次集合，
  // 第一个请求同时在创建：两次首次读各自读盘，后返回的那次不能把已经写进 cache 的条目覆盖掉
  const first = c.list()
  const item = await c.create({ name: 'first' })
  await first
  assert.equal((await c.get(item.id))?.name, 'first')
  assert.deepEqual(
    (await c.list()).map((x) => x.name),
    ['first'],
  )
})

test('并发更新不同的条目，两边的改动都保留', async () => {
  const c = createCollection('concurrent-update.json', Item)
  const a = await c.create({ name: 'a' })
  const b = await c.create({ name: 'b' })

  await Promise.all([c.update(a.id, { ...a, name: 'a2' }), c.update(b.id, { ...b, name: 'b2' })])

  const list = await c.list()
  assert.equal(list.find((x) => x.id === a.id)?.name, 'a2')
  assert.equal(list.find((x) => x.id === b.id)?.name, 'b2')
})
