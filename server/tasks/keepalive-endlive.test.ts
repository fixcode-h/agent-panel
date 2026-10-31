/**
 * 结束对话的 CLI（endLive）：取消等下一句后 CLI 不退出时限时强制停掉，收尾不能一直卡着。
 * 以前子对话收尾在这里无限等，执行位一直占着，父对话再交代任务时卡在「收尾那一刻」。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { StopReason } from '../../shared/schema.ts'
import { createKeepAlive } from './keepalive.ts'
import type { TasksScope } from './scope.ts'
import type { Live } from './types.ts'

/** stopAt：第几次停止时进程才结束（1 = 一停就退；2 = 第一次停不下来，要限时后再停一次） */
function rig(stopAt: number) {
  let release: () => void = () => {}
  let stops = 0
  const entry = {
    task: { id: 'kid' },
    abort: { abort: () => ++stops === stopAt && release() },
    done: new Promise<void>((r) => (release = r)),
  } as unknown as Live
  const s = { live: new Map([['kid', entry]]), closeChildren: async () => {} } as unknown as TasksScope
  return { ...createKeepAlive(s), entry, release, stops: () => stops }
}

test('取消等待后 CLI 不退出：限时到了按收尾原因强制停掉，不一直等', async () => {
  const r = rig(2)
  const t0 = Date.now()
  // 限时的定时器 unref 了：留一个定时器撑住事件循环
  const hold = setTimeout(() => {}, 5000)
  await r.endLive('kid', r.entry, 'finish', 30)
  clearTimeout(hold)
  assert.ok(Date.now() - t0 < 2000)
  // 第一次停没停下来：到点又停了一次
  assert.equal(r.stops(), 2)
  assert.equal(r.entry.stopReason, 'finish' satisfies StopReason)
})

test('限时内收完就返回，不等满时限', async () => {
  const r = rig(99)
  setTimeout(() => r.release(), 5)
  const t0 = Date.now()
  await r.endLive('kid', r.entry, 'finish', 5000)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(r.stops(), 1)
})
