import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { emptyRoot, type Design } from '../shared/design.ts'
import { versionStore } from './design-versions.ts'

const design = (): Design =>
  ({
    id: 'd1',
    root: emptyRoot('game'),
    components: [],
    designSize: { X: 1920, Y: 1080 },
    style: '',
    images: [],
    animations: [],
    data: { sets: [{ id: 'items', name: 'Items', label: '', fields: [], rows: [{ n: 1 }] }] },
  }) as unknown as Design

test('同一个设计同时存几个版本（手动 + AI 开轮自动存）一条都不丢，删除也排在同一条队里', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-versions-'))
  try {
    const store = versionStore((id) => path.join(dir, id, 'versions.json'))
    const d = design()
    const made = await Promise.all([
      store.add(d, '手动', false),
      store.add(d, 'AI 修改前', true),
      store.add(d, '再存一个', false),
    ])
    const list = await store.read('d1')
    assert.deepEqual(new Set(list.map((v) => v.id)), new Set(made.map((v) => v.id)))
    // 快照带画板数据
    assert.equal(list[0].snapshot.data?.sets[0]?.name, 'Items')
    await Promise.all([store.remove('d1', made[0].id), store.add(d, '删的同时存', false)])
    const after = await store.read('d1')
    assert.equal(after.length, 3)
    assert.ok(!after.some((v) => v.id === made[0].id))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
