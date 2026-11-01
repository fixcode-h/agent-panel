import assert from 'node:assert/strict'
import test from 'node:test'
import type { CaptureRequest } from '../shared/design.ts'
import { emptyRoot } from '../shared/design.ts'
import { DesignCaptures, captureNoHeadless, captureNoPage, captureNoShot } from './design-capture.ts'

const view = (id: string): CaptureRequest => ({
  id,
  target: '',
  root: emptyRoot('game'),
  components: [],
  size: { X: 100, Y: 100 },
})

test('页面挂着的长轮询立刻拿到截图请求，交回后 resolve', async () => {
  const c = new DesignCaptures({ graceMs: 50, timeoutMs: 500 })
  const wait = c.wait('d1')
  const shot = c.request('d1', view('c1'))
  const got = await wait
  assert.equal(got?.id, 'c1')
  const png = Buffer.from('x')
  assert.equal(c.deliver('d1', 'c1', { png, rects: [] }), true)
  assert.deepEqual(await shot, { png, rects: [] })
})

test('页面没打开时快速报「页面没有打开」，不等截图超时', async () => {
  const c = new DesignCaptures({ graceMs: 20, timeoutMs: 5_000 })
  const started = Date.now()
  await assert.rejects(c.request('d1', view('c1')), { message: captureNoPage().message })
  assert.ok(Date.now() - started < 1_000, '应该在宽限期结束时失败')
})

test('页面拿到了请求但没交回，超时时说清楚已经收到过', async () => {
  const c = new DesignCaptures({ graceMs: 50, timeoutMs: 40 })
  const wait = c.wait('d1')
  const shot = c.request('d1', view('c1'))
  assert.equal((await wait)?.id, 'c1')
  await assert.rejects(shot, { message: captureNoShot().message })
})

test('页面画不出来时把原因原样交给 AI', async () => {
  const c = new DesignCaptures({ graceMs: 50, timeoutMs: 500 })
  const wait = c.wait('d1')
  const shot = c.request('d1', view('c1'))
  await wait
  assert.equal(c.fail('d1', 'c1', '画布是空的：这棵树里还没有可截的控件'), true)
  await assert.rejects(shot, { message: '画布是空的：这棵树里还没有可截的控件' })
})

test('这一轮结束时还在等的截图立刻失败', async () => {
  const c = new DesignCaptures({ graceMs: 50, timeoutMs: 5_000 })
  const wait = c.wait('d1')
  const shot = c.request('d1', view('c1'))
  await wait
  c.stop('d1', new Error('已停止'))
  await assert.rejects(shot, { message: '已停止' })
})

test('超时后迟到的截图不会再影响下一次请求', async () => {
  const c = new DesignCaptures({ graceMs: 5, timeoutMs: 20 })
  await assert.rejects(c.request('d1', view('c1')), { message: captureNoPage().message })
  assert.equal(c.deliver('d1', 'c1', { png: Buffer.from('x'), rects: [] }), false)
})

test('页面离开后请求按「页面没有打开」处理', async () => {
  const c = new DesignCaptures({ graceMs: 15, timeoutMs: 5_000 })
  const ctrl = new AbortController()
  const wait = c.wait('d1', ctrl.signal)
  ctrl.abort()
  assert.equal(await wait, null)
  await assert.rejects(c.request('d1', view('c1')), { message: captureNoPage().message })
})

test('没有截图请求时长轮询到期返回空，页面据此重连', async () => {
  const c = new DesignCaptures({ askMs: 20 })
  assert.equal(await c.wait('d1'), null)
})

test('没有页面时先拉起无头浏览器里的截图页，它连上来就照常交图', async () => {
  const launched: string[] = []
  const c = new DesignCaptures({
    graceMs: 10,
    launchGraceMs: 2_000,
    timeoutMs: 500,
    onNoPage: (id) => {
      launched.push(id)
      return true
    },
  })
  const shot = c.request('d1', view('c1'))
  assert.deepEqual(launched, ['d1'])
  // 无头页面过一会儿才连上：普通宽限早就过了，但拉起后的宽限还没到
  await new Promise((r) => setTimeout(r, 50))
  const got = await c.wait('d1')
  assert.equal(got?.id, 'c1')
  c.deliver('d1', 'c1', { png: Buffer.from('x'), rects: [] })
  assert.equal((await shot).rects.length, 0)
})

test('有页面挂着时不拉无头浏览器；拉起来也没连上就说清楚', async () => {
  let launches = 0
  const c = new DesignCaptures({
    graceMs: 10,
    launchGraceMs: 30,
    timeoutMs: 500,
    onNoPage: () => {
      launches++
      return true
    },
  })
  const wait = c.wait('d1')
  const ok = c.request('d1', view('c1'))
  await wait
  c.deliver('d1', 'c1', { png: Buffer.from('x'), rects: [] })
  await ok
  assert.equal(launches, 0)
  await assert.rejects(c.request('d1', view('c2')), { message: captureNoHeadless().message })
  assert.equal(launches, 1)
})

test('找不到浏览器时和以前一样快速报「页面没有打开」', async () => {
  const c = new DesignCaptures({ graceMs: 10, timeoutMs: 5_000, onNoPage: () => false })
  await assert.rejects(c.request('d1', view('c1')), { message: captureNoPage().message })
})
