/**
 * 提示排队：名额内直接弹、满了排队、前面的消失后按先后补位。
 * 只有这一层能做单测——投递动作本身要 sonner 和 DOM，交给界面检查（scripts/ui/10-toast.mjs）。
 */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { TOAST_VISIBLE_LIMIT, enqueueToast, finishToast, clearToastQueue, toastQueueState } from '@/lib/toast-queue'

beforeEach(() => clearToastQueue())

/** 一个假的投递动作：记录它弹的是什么，返回递增的 id（和 sonner 一样返回 id） */
function spinner() {
  const popped: string[] = []
  let seq = 0
  const publish = (text: string) => () => {
    popped.push(text)
    seq += 1
    return seq
  }
  return { popped, publish }
}

test('名额没满时立刻投递，返回值是投递到的 id', () => {
  const { popped, publish } = spinner()
  const first = enqueueToast(publish('第一条'))
  const second = enqueueToast(publish('第二条'))

  assert.deepEqual(popped, ['第一条', '第二条'])
  assert.deepEqual([first, second], [1, 2])
  assert.deepEqual(toastQueueState(), { shown: [1, 2], waiting: 0 })
})

test('超出的排到队尾、先不投递', () => {
  const { popped, publish } = spinner()
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) enqueueToast(publish(`第${i}条`))
  const queued = enqueueToast(publish('排队的第六条'))

  assert.equal(popped.length, TOAST_VISIBLE_LIMIT, '名额满了之后不能再弹')
  assert.equal(queued, undefined, '排队时没有 id')
  assert.deepEqual(toastQueueState(), {
    shown: Array.from({ length: TOAST_VISIBLE_LIMIT }, (_, i) => i + 1),
    waiting: 1,
  })
})

test('前面的消失后按先后补位，一次只补一条', () => {
  const { popped, publish } = spinner()
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) enqueueToast(publish(`第${i}条`))
  enqueueToast(publish('甲'))
  enqueueToast(publish('乙'))

  finishToast(1)
  assert.deepEqual(popped.at(-1), '甲', '队列是先进先出')
  assert.equal(toastQueueState().waiting, 1)

  finishToast(2)
  assert.deepEqual(popped.at(-1), '乙')
  assert.equal(toastQueueState().waiting, 0)
})

test('同一条提示只结算一次：先到期再被移除不会多补位', () => {
  const { popped, publish } = spinner()
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) enqueueToast(publish(`第${i}条`))
  enqueueToast(publish('甲'))
  enqueueToast(publish('乙'))

  // sonner 到期时 onAutoClose、真正移除时 onDismiss，两个回调都会来
  finishToast(1)
  finishToast(1)

  assert.equal(popped.filter((p) => p === '甲').length, 1)
  assert.equal(popped.filter((p) => p === '乙').length, 0, '乙还在排队')
})

test('不是这里投递的 id 不影响名额', () => {
  const { popped, publish } = spinner()
  enqueueToast(publish('第一条'))
  finishToast('别的提示')

  assert.deepEqual(toastQueueState(), { shown: [1], waiting: 0 })
  assert.equal(popped.length, 1)
})

test('名额一直有位置时永远不排队（连续十条全都在名额内）', () => {
  const { popped, publish } = spinner()
  for (let i = 0; i < 10; i += 1) {
    enqueueToast(publish(`第${i}条`))
    finishToast(i + 1)
  }

  assert.equal(popped.length, 10)
  assert.deepEqual(toastQueueState(), { shown: [], waiting: 0 })
})

test('清空后队里排着的不会再弹出来（关掉全部提示时用）', () => {
  const { popped, publish } = spinner()
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) enqueueToast(publish(`第${i}条`))
  enqueueToast(publish('排着的'))
  clearToastQueue()

  // 屏幕上的那几条按 sonner 的移除回调回来结算，也不能把清空前的队列补出来
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) finishToast(i)

  assert.equal(popped.filter((p) => p === '排着的').length, 0)
  assert.deepEqual(toastQueueState(), { shown: [], waiting: 0 })
})

test('clearToastQueue 清掉名额和队列', () => {
  const { publish } = spinner()
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT + 2; i += 1) enqueueToast(publish(`第${i}条`))
  clearToastQueue()

  assert.deepEqual(toastQueueState(), { shown: [], waiting: 0 })
  assert.notEqual(enqueueToast(publish('清空后第一条')), undefined, '清空后直接投递，不用再排队')
})
