/**
 * 统一入口 `web/src/lib/toast.ts` 的队列接线：每个类型都要过队列，`dismiss` 要和队列对得上账。
 * 排队本身的规则在 toast-queue.test.ts；这里只测「入口有没有把两边的账本接对」。
 *
 * sonner 在没有 DOM 的环境里也能调（只往自己的数组里记），所以能直接断言 `getHistory()`。
 */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { toast } from '@/lib/toast'
import { TOAST_VISIBLE_LIMIT, clearToastQueue, toastQueueState } from '@/lib/toast-queue'

/** 每个用例从干净状态开始：队列是模块级的，sonner 的历史也是 */
beforeEach(() => {
  toast.dismiss()
  clearToastQueue()
})

/**
 * `sonner.dismiss(id)` 要等下一帧才把关闭信号发给订阅者（StrictMode 下新建同 id 时能取消），
 * 用的是 `requestAnimationFrame`；单测跑在 Node 里没有这个，`toast.dismiss(id)` 会直接报错。
 * 用宏任务顶替：不影响本文件里的断言（这里不断言关闭后的回调时机）。
 */
if (typeof globalThis.requestAnimationFrame !== 'function')
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame

/** 入口最后一次投递落到了 sonner（不看历史里以前留下的） */
const lastTitle = () => {
  const items = toast.getHistory()
  const last = items.at(-1)
  return last && 'title' in last ? last.title : undefined
}

test('每一种类型都经过队列', () => {
  for (const kind of ['success', 'error', 'warning', 'info', 'message'] as const) {
    clearToastQueue()
    assert.notEqual(toast[kind](`${kind} 一条`), undefined, `${kind} 没有经过队列投递`)
    assert.equal(lastTitle(), `${kind} 一条`)
  }
})

test('名额满了之后排队的提示不投递（排队时返回 undefined）', () => {
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) toast.success(`第${i}条`)
  const queued = toast.success('排队的')
  assert.equal(queued, undefined, '排队时不该返回 id')
  assert.equal(lastTitle(), `第${TOAST_VISIBLE_LIMIT}条`, '排队的那条不该投递出去')
  assert.equal(toastQueueState().waiting, 1)
})

test('dismiss 全部：排队的不能在被关掉之后又冒出来', () => {
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) toast.success(`第${i}条`)
  toast.success('排着的甲')
  toast.success('排着的乙')

  toast.dismiss()

  // 关掉全部之后又补位投递，屏幕上会多出几条「谁也关不掉」的提示，队列账本也对不上
  assert.notEqual(lastTitle(), '排着的甲', '关掉全部之后排队的那条又被弹出来了')
  assert.notEqual(lastTitle(), '排着的乙', '关掉全部之后排队的那条又被弹出来了')
  assert.deepEqual(toastQueueState(), { shown: [], waiting: 0 })
})

test('dismiss 全部之后接着弹：名额是全空的，不会一上来就排队', () => {
  for (let i = 1; i <= TOAST_VISIBLE_LIMIT + 2; i += 1) toast.success(`第${i}条`)
  toast.dismiss()

  for (let i = 1; i <= TOAST_VISIBLE_LIMIT; i += 1) {
    assert.notEqual(toast.success(`关掉后第${i}条`), undefined, '关掉全部之后应当还有满额的投递位置')
  }
})
