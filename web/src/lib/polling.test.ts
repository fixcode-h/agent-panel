import assert from 'node:assert/strict'
import test from 'node:test'
import { startPolling } from './polling.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('startPolling：上一次回来才排下一次，后台时不发，切回前台马上补一次', async () => {
  let hidden = false
  let wake = () => {}
  let calls = 0
  let release = () => {}
  const stop = startPolling({
    intervalMs: 20,
    hidden: () => hidden,
    onVisible: (cb) => ((wake = cb), () => {}),
    run: () => {
      calls++
      // 第一次请求很慢：这期间不能再发第二个
      return calls === 1 ? new Promise<void>((r) => (release = r)) : undefined
    },
  })
  await sleep(80)
  assert.equal(calls, 1, '慢请求没回来时不叠请求')
  release()
  await sleep(50)
  assert.ok(calls >= 2, '回来以后照常继续')
  hidden = true
  const before = calls
  await sleep(80)
  assert.equal(calls, before, '标签页在后台时不发')
  hidden = false
  wake()
  await sleep(5)
  assert.equal(calls, before + 1, '切回前台立即补一次')
  stop()
  const end = calls
  await sleep(60)
  assert.equal(calls, end, '停下后不再发')
})

test('startPolling：一次失败不让轮询停下', async () => {
  let calls = 0
  const stop = startPolling({
    intervalMs: 10,
    hidden: () => false,
    onVisible: () => () => {},
    run: () => {
      calls++
      throw new Error('网络断了')
    },
  })
  await sleep(60)
  stop()
  assert.ok(calls >= 3)
})
