/**
 * 子对话分支状态的读缓存（server/worktree-cache.ts）：
 * 界面用的 `peek` 必须立即返回、不等 git，判定用的 `read` 才等结果；
 * 同一个子对话同一时刻只跑一条 git——轮询再快也不能叠加成上百个 git 进程。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { createWorktreeCache } = await import('./worktree-cache.ts')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 不设并发上限：这个测试只关心缓存，不关心排队 */
const open = <T>(run: () => Promise<T>) => run()
type St = { merged: boolean }

test('peek 不等 git：第一次回「还没核对过」，后台补完下一次就有值', async () => {
  let calls = 0
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const load = async () => {
    calls++
    await sleep(50)
    return { merged: false }
  }
  assert.deepEqual(cache.peek('a', 'k1', 15_000, load), { value: null, checked: false })
  assert.equal(calls, 1, 'peek 之后要顺手补一次')
  await sleep(120)
  assert.deepEqual(cache.peek('a', 'k1', 15_000, load), { value: { merged: false }, checked: true })
  assert.equal(calls, 1, 'TTL 内不重复查')
})

test('并发问同一个子对话：只跑一条 git', async () => {
  let calls = 0
  let release!: () => void
  const blocked = new Promise<void>((r) => (release = r))
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const load = async () => {
    calls++
    await blocked
    return { merged: true }
  }
  for (let i = 0; i < 20; i++) cache.peek('a', 'k', 1_000, load)
  const reading = Promise.all(Array.from({ length: 10 }, () => cache.read('a', 'k', 1_000, load)))
  assert.equal(calls, 1, '20 次 peek 和 10 次 read 都复用在跑的那一条')
  release()
  for (const got of await reading) assert.deepEqual(got, { value: { merged: true }, checked: true })
  assert.equal(calls, 1)
})

test('过期的先给旧的，同时后台补新的', async () => {
  let now = 0
  let calls = 0
  const cache = createWorktreeCache<St>({ gate: open, background: open, now: () => now })
  const load = async () => ({ merged: ++calls === 1 })
  assert.deepEqual(await cache.read('a', 'k', 100, load), { value: { merged: true }, checked: true })
  now = 200
  assert.deepEqual(cache.peek('a', 'k', 100, load), { value: { merged: true }, checked: true }, '先给旧的')
  await sleep(20)
  assert.deepEqual(cache.peek('a', 'k', 100, load), { value: { merged: false }, checked: true }, '后台已补上新的')
  assert.equal(calls, 2)
})

test('key 变了就不算核对过：上一轮的状态不能拿来显示这一轮', async () => {
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const load = async () => ({ merged: true })
  await cache.read('a', 'k1', 15_000, load)
  assert.deepEqual(cache.peek('a', 'k2', 15_000, load), { value: null, checked: false })
})

test('git 读不出来：界面留上一次的值，但不写成「已经合回」', async () => {
  let now = 0
  let fail = false
  const cache = createWorktreeCache<St>({ gate: open, background: open, now: () => now })
  const load = async () => {
    if (fail) throw new Error('fatal: not a git repository')
    return { merged: false }
  }
  await cache.read('a', 'k', 100, load)
  fail = true
  now = 20_000
  assert.deepEqual(cache.peek('a', 'k', 100, load), { value: { merged: false }, checked: true })
  await sleep(20)
  assert.deepEqual(cache.peek('a', 'k', 100, load), { value: { merged: false }, checked: true }, '失败不动缓存')
})

test('读失败不算核对过：read 必须说「没查到」，不能给出干净的结果', async () => {
  let now = 0
  let fail = false
  const cache = createWorktreeCache<St>({ gate: open, background: open, now: () => now })
  const load = async () => {
    if (fail) throw new Error('fatal: bad object')
    return { merged: false }
  }
  await cache.read('a', 'k', 100, load)
  fail = true
  now = 20_000
  // 判定用：等了一次、失败了 → checked 是 false，调用方据此「不拍板」（不能当「已合回 / 没有未提交」）
  assert.deepEqual(await cache.read('a', 'k', 100, load), { value: null, checked: false })
  // 界面用：还留着上一次成功的值，不会因为一次失败闪成「已合回」
  assert.deepEqual(cache.peek('a', 'k', 100, load), { value: { merged: false }, checked: true })
})

test('read 等这次的结果（判定完成用）', async () => {
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const load = async () => {
    await sleep(60)
    return { merged: true }
  }
  const began = Date.now()
  assert.deepEqual(await cache.read('b', 'k', 0, load), { value: { merged: true }, checked: true })
  assert.ok(Date.now() - began >= 50, 'read 不能不等')
})

test('后台补走单独那道闸：不和等结果的判定抢', async () => {
  const lanes: string[] = []
  const lane =
    (name: string) =>
    <R>(run: () => Promise<R>) => {
      lanes.push(name)
      return run()
    }
  const cache = createWorktreeCache<St>({ gate: lane('front'), background: lane('back') })
  const load = async () => ({ merged: true })
  cache.peek('a', 'k', 15_000, load)
  await cache.read('b', 'k', 15_000, load)
  assert.deepEqual(lanes, ['back', 'front'], '界面读走后台闸，判定读走前台闸')
})

test('key 变了也不并发第二条 git，旧那轮的结果不算新的一轮', async () => {
  const calls: string[] = []
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const load = (tag: string) => async () => {
    calls.push(tag)
    await sleep(50)
    return { merged: tag === 'old' }
  }
  assert.deepEqual(cache.peek('a', 'old', 15_000, load('old')), { value: null, checked: false })
  // 还没跑完子对话就动了新的一轮：不能再起一条
  assert.deepEqual(cache.peek('a', 'new', 15_000, load('new')), { value: null, checked: false })
  assert.deepEqual(calls, ['old'], '同一时刻只有一条 git')
  await sleep(120)
  // 旧那轮的结果不能当成新一轮的：换 key 之后要按新 key 再查
  assert.deepEqual(cache.peek('a', 'new', 15_000, load('new')), { value: null, checked: false })
  assert.deepEqual(calls, ['old', 'new'])
  await sleep(120)
  assert.deepEqual(cache.peek('a', 'new', 15_000, load('new')), { value: { merged: false }, checked: true })
})

test('read 遇到在跑的是别的轮次：等它结束，再按当前这一轮查（不拿旧值拍板）', async () => {
  const calls: string[] = []
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const load = (tag: string) => async () => {
    calls.push(tag)
    await sleep(50)
    return { merged: tag === 'old' }
  }
  cache.peek('a', 'old', 15_000, load('old'))
  assert.deepEqual(await cache.read('a', 'new', 15_000, load('new')), {
    value: { merged: false },
    checked: true,
  })
  assert.deepEqual(calls, ['old', 'new'], '同时只有一条，但最终拿到的是当前这一轮的结果')
})

test('两个判定同时撞上别的轮次：各自拿自己那一轮的值，不串整', async () => {
  let release!: () => void
  const blocked = new Promise<void>((r) => (release = r))
  const calls: string[] = []
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const load = (tag: string, merged: boolean) => async () => {
    calls.push(tag)
    if (tag === 'K1') await blocked
    await sleep(10)
    return { merged }
  }
  // 旧一轮还在跑，期间来了两个更晚的判定
  cache.peek('a', 'K1', 15_000, load('K1', true))
  const k2 = cache.read('a', 'K2', 0, load('K2', false))
  const k4 = cache.read('a', 'K4', 0, load('K4', true))
  release()
  const [got2, got4] = await Promise.all([k2, k4])
  assert.deepEqual(got2, { value: { merged: false }, checked: true }, 'K2 看到的是没合回')
  assert.deepEqual(got4, { value: { merged: true }, checked: true }, 'K4 看到的是已合回，不能拿到 K2 的值')
})

test('只是用新 key 问一句，不能把在跑那条的结果丢掉', async () => {
  const cache = createWorktreeCache<St>({ gate: open, background: open })
  const calls: string[] = []
  const load = (tag: string) => async () => {
    calls.push(tag)
    await sleep(40)
    return { merged: true }
  }
  cache.peek('a', 'K1', 15_000, load('K1'))
  // 子对话又动了一轮：这次 peek 只复用正在跑那条，不应该把 K1 的结果判成过时
  cache.peek('a', 'K2', 15_000, load('K2'))
  await sleep(100)
  assert.deepEqual(calls, ['K1'], '同一时刻只有一条 git')
  assert.deepEqual(
    cache.peek('a', 'K1', 15_000, load('K1')),
    { value: { merged: true }, checked: true },
    'K1 的结果要落进缓存',
  )
})

test('缓存不会无限长：超出上限丢掉问得最早的那条', async () => {
  let now = 0
  const cache = createWorktreeCache<St>({ gate: open, background: open, now: () => now, keep: 2 })
  const load = async () => ({ merged: true })
  for (const id of ['a', 'b', 'c']) {
    await cache.read(id, 'k', 15_000, load)
    now += 10
  }
  assert.deepEqual(cache.peek('a', 'k', 15_000, load), { value: null, checked: false }, 'a 被挤掉了')
  assert.deepEqual(cache.peek('c', 'k', 15_000, load), { value: { merged: true }, checked: true })
})
