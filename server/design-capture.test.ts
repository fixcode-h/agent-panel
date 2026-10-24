import assert from 'node:assert/strict'
import test from 'node:test'
import type { CaptureRequest } from '../shared/design.ts'
import { emptyRoot } from '../shared/design.ts'
import { DesignCaptures, captureNoPage, captureNoShot } from './design-capture.ts'

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
