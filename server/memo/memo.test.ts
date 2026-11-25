// 派生缓存 + 文件监听（server/memo、server/watch，ADR 0074）：在途去重、失败不记、过期、依赖文件变了就重算、共用目录监听
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { watchDir, openDirWatches } from '../watch/dir.ts'
import { watchFiles } from '../watch/files.ts'
import { clearMemos, createMemo, memoStats } from './index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('同一个键同时只算一遍，算失败不记', async () => {
  let n = 0
  const m = createMemo<string, number>({
    name: 'test.dedupe',
    load: async (k) => {
      n++
      await sleep(10)
      if (k === 'bad' && n < 3) throw new Error('boom')
      return n
    },
  })
  const [a, b] = await Promise.all([m.get('x'), m.get('x')])
  assert.equal(a, b)
  assert.equal(n, 1)
  await assert.rejects(m.get('bad'))
  await sleep(0)
  assert.equal(m.peek('bad'), undefined, '失败的不留')
  assert.equal(await m.get('bad'), 3)
  assert.equal(await m.get('x', { fresh: true }), 4)
})

test('过期后重算；登记表能看到、能清空', async () => {
  let n = 0
  const m = createMemo<string, number>({ name: 'test.ttl', ttlMs: 20, load: async () => ++n })
  assert.equal(await m.get('k'), 1)
  assert.equal(await m.get('k'), 1)
  await sleep(30)
  assert.equal(await m.get('k'), 2)
  assert.deepEqual(
    memoStats().find((s) => s.name === 'test.ttl'),
    { name: 'test.ttl', size: 1 },
  )
  clearMemos('test.ttl')
  assert.equal(m.size(), 0)
})

test('依赖的文件改了就丢掉，下次重算', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'memo-'))
  try {
    const f = path.join(dir, 'a.json')
    await writeFile(f, '1')
    let n = 0
    const m = createMemo<string, number>({
      name: 'test.files',
      load: async () => ++n,
      watch: () => ({ files: [f] }),
    })
    assert.equal(await m.get('k'), 1)
    await sleep(50)
    await writeFile(f, '22')
    for (let i = 0; i < 40 && m.size(); i++) await sleep(50)
    assert.equal(m.size(), 0, '文件改了之后键被丢掉')
    assert.equal(await m.get('k'), 2)
    m.invalidate()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('同一目录的订阅共用一个系统监听；watchFiles 一次保存只回调一次', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'watch-'))
  try {
    const before = openDirWatches()
    const a = watchDir(dir, () => {})
    const b = watchDir(dir, () => {})
    assert.equal(openDirWatches(), before + 1)
    a?.close()
    b?.close()
    assert.equal(openDirWatches(), before)

    const f = path.join(dir, 'gm.json')
    await writeFile(f, '{}')
    const calls: string[][] = []
    // 停手时间用默认的 300 毫秒：CI 机器忙时两次写之间、事件送达之间能隔出 50 毫秒以上，settleMs 太短会被拆成两次回调
    const w = watchFiles([f], (c) => calls.push(c.map((x) => path.basename(x.file))))
    await sleep(50)
    await writeFile(f, '{"a":1}')
    await writeFile(f, '{"a":2}')
    for (let i = 0; i < 40 && !calls.length; i++) await sleep(50)
    await sleep(400)
    w.close()
    assert.deepEqual(calls, [['gm.json']])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
