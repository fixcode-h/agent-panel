/**
 * 打开对话时的加载日志：每一步的状态和耗时都按真实时间记录，界面据此判断「卡在哪一步」。
 * 这里的逻辑算错会让界面显示假时长、或者失败被 finally 的「完成」盖掉，所以单独测。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LOAD_STEPS,
  abortWaiting,
  createTrace,
  failStep,
  finishStep,
  recoverStep,
  skipStep,
  startStep,
  stepElapsed,
  traceSettled,
} from '@/lib/load-trace'

const find = (steps: ReturnType<typeof createTrace>, id: (typeof LOAD_STEPS)[number]) => steps.find((s) => s.id === id)!

test('一开始每一步都是等待中，没有起点和耗时', () => {
  const steps = createTrace()
  assert.deepEqual(
    steps.map((s) => s.id),
    [...LOAD_STEPS],
  )
  assert.ok(steps.every((s) => s.status === 'waiting'))
  assert.equal(stepElapsed(find(steps, 'task'), 1_000), undefined)
  assert.equal(traceSettled(steps), false)
})

test('发起后是进行中，已等待时长按时钟现算', () => {
  const steps = startStep(createTrace(), 'task', 1_000)
  assert.equal(find(steps, 'task').status, 'running')
  assert.equal(stepElapsed(find(steps, 'task'), 1_000), 0)
  assert.equal(stepElapsed(find(steps, 'task'), 2_500), 1_500)
})

test('结束时按起止算耗时，后面的步骤不受影响', () => {
  let steps = startStep(createTrace(), 'task', 1_000)
  steps = finishStep(steps, 'task', 1_038)
  assert.equal(find(steps, 'task').status, 'done')
  assert.equal(stepElapsed(find(steps, 'task'), 9_999), 38)
  assert.equal(find(steps, 'children').status, 'waiting')
})

test('重复发起不会把已等待的时长清零', () => {
  let steps = startStep(createTrace(), 'children', 1_000)
  steps = startStep(steps, 'children', 3_000)
  assert.equal(stepElapsed(find(steps, 'children'), 4_000), 3_000)
})

test('结束带上这一步实际做了什么', () => {
  let steps = startStep(createTrace(), 'render', 1_000)
  steps = finishStep(steps, 'render', 1_400, '611 条消息')
  assert.equal(find(steps, 'render').detail, '611 条消息')
})

test('渲染这一步要真的记起点：数据到手到两帧画完之间的耗时不能是 0', () => {
  // 以前只在两帧后记「完成」，起点由 finishStep 补成结束时刻，那行永远写 0s
  let steps = startStep(createTrace(), 'render', 1_000)
  steps = finishStep(steps, 'render', 1_320, '611 条消息')
  assert.equal(stepElapsed(find(steps, 'render')), 320)
})

test('失败留下错误原文，finally 里的完成不会把它盖成正常', () => {
  let steps = startStep(createTrace(), 'task', 1_000)
  steps = failStep(steps, 'task', 'Failed to fetch', 1_100)
  assert.equal(find(steps, 'task').status, 'failed')
  assert.equal(find(steps, 'task').error, 'Failed to fetch')
  assert.equal(stepElapsed(find(steps, 'task'), 9_999), 100)
  steps = finishStep(steps, 'task', 1_200)
  assert.equal(find(steps, 'task').status, 'failed')
  assert.equal(find(steps, 'task').error, 'Failed to fetch')
})

test('还没发起的步骤直接标完成：起点补成结束时刻，不会算出负耗时', () => {
  const steps = finishStep(createTrace(), 'seen', 5_000)
  assert.equal(find(steps, 'seen').status, 'done')
  assert.equal(stepElapsed(find(steps, 'seen'), 5_100), 0)
})

test('失败后重连成功：恢复成完成并清掉错误，耗时从失败算到恢复', () => {
  // 实时推送首包前断一次、重连成功时会走到这；不恢复的话面板会永久停在「加载失败」
  let steps = startStep(createTrace(), 'stream', 1_000)
  steps = failStep(steps, 'stream', '实时更新连接失败，正在重连', 1_200)
  steps = recoverStep(steps, 'stream', '重新连上了', 3_500)
  const step = find(steps, 'stream')
  assert.equal(step.status, 'done')
  assert.equal(step.error, undefined)
  assert.equal(step.detail, '重新连上了')
  assert.equal(stepElapsed(step), 2_500)
  // 没失败的步骤不受影响
  const untouched = recoverStep(steps, 'task', '不该写进去')
  assert.equal(find(untouched, 'task').status, 'waiting')
})

test('不走这一步的标成未执行并写明原因，已经跑完的不动', () => {
  let steps = startStep(createTrace(), 'task', 1_000)
  steps = finishStep(steps, 'task', 1_100)
  steps = skipStep(steps, 'stream', '演示版没有实时推送')
  steps = skipStep(steps, 'task', '不该覆盖')
  assert.equal(find(steps, 'stream').status, 'skipped')
  assert.equal(find(steps, 'stream').detail, '演示版没有实时推送')
  assert.equal(find(steps, 'task').status, 'done')
})

test('某一步失败后，还没开始的步骤标成未执行，正在跑的不动', () => {
  let steps = startStep(createTrace(), 'task', 1_000)
  steps = startStep(steps, 'children', 1_000)
  steps = failStep(steps, 'task', '接口挂了', 1_200)
  steps = abortWaiting(steps)
  assert.equal(find(steps, 'children').status, 'running')
  assert.equal(find(steps, 'render').status, 'skipped')
})

test('全部结束才算走完；跳过也算走完', () => {
  let steps = createTrace(['task', 'stream'])
  steps = finishStep(startStep(steps, 'task', 1_000), 'task', 1_100)
  assert.equal(traceSettled(steps), false)
  steps = skipStep(steps, 'stream', '演示版没有实时推送')
  assert.equal(traceSettled(steps), true)
})
