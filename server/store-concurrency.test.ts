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

test('集合里一条数据读不懂：其余照常加载，那一条写盘时原样保留，并留档到 broken/', async () => {
  const { writeFileSync, readdirSync, existsSync } = await import('node:fs')
  const file = path.join(dir, 'mixed.json')
  const good = { id: 'a', name: 'ok', createdAt: 'x', updatedAt: 'x' }
  const bad = { id: 'b', name: 42, createdAt: 'x', updatedAt: 'x' }
  writeFileSync(file, JSON.stringify([good, bad]))
  const c = createCollection('mixed.json', Item)
  assert.deepEqual(
    (await c.list()).map((x) => x.id),
    ['a'],
    '坏的那条跳过，不让整个集合读不出来',
  )
  await c.create({ name: 'new' })
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { id: string }[]
  assert.ok(
    onDisk.some((x) => x.id === 'b'),
    '读不懂的那条写回文件，升回能读懂的版本还在',
  )
  assert.equal(onDisk.length, 3)
  const broken = path.join(dir, 'broken')
  assert.ok(existsSync(broken) && readdirSync(broken).some((f) => f.startsWith('mixed.json.items-')), '留档了一份')
})

test('集合写盘失败：接口报错，内存里还是旧值', async () => {
  const { mkdirSync } = await import('node:fs')
  const c = createCollection('unwritable.json', Item)
  await c.create({ name: 'first' })
  // 把目标文件换成同名目录：rename 到它上面必然失败
  const { rmSync } = await import('node:fs')
  rmSync(path.join(dir, 'unwritable.json'))
  mkdirSync(path.join(dir, 'unwritable.json'))
  await assert.rejects(c.create({ name: 'second' }))
  assert.deepEqual(
    (await c.list()).map((x) => x.name),
    ['first'],
    '写失败的那条没进缓存',
  )
})
