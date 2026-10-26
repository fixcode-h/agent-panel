/**
 * 提示的统一入口：所有代码都从这里取 `toast`，不要直接 `import { toast } from 'sonner'`。
 *
 * 只为了排队这一件事——sonner 的 `visibleToasts` 不是排队（见 `web/src/lib/toast-queue.ts` 的说明），
 * 要「同屏几条、其余等前面的消失后再出现」只能自己在投递前卡一道。
 * 这里把每条提示都先交给队列，sonner 真移除它时回来腾名额、补位下一条。
 *
 * 其余行为原样转发给 sonner：类型（success / error / warning / info）、动作按钮、
 * `duration`（包括 `Infinity`）、`description` 里的 JSX 都不动；`getHistory` 直接透传。
 * `dismiss` 是队列之外的旁路：sonner 会自己调一次 `onDismiss`，这里再结算一次，靠 `finishToast` 幂等兜住。
 */
import { toast as sonner } from 'sonner'
import type { ExternalToast, ToastT } from 'sonner'
import { clearToastQueue, enqueueToast, finishToast } from '@/lib/toast-queue'

type Title = Parameters<typeof sonner>[0]

/**
 * 给投递出去的提示挂上「移除时回来补位」。
 * 调用方自己写的 `onDismiss` / `onAutoClose` 照常调用，不吞掉。
 * 两个回调都要挂：手动关 / 划走只走 `onDismiss`，计时到期只走 `onAutoClose`。
 */
function withQueue(data: ExternalToast | undefined, settle: (id: number | string) => void) {
  return {
    ...data,
    onDismiss: (removed: ToastT) => {
      settle(removed.id)
      data?.onDismiss?.(removed)
    },
    onAutoClose: (removed: ToastT) => {
      settle(removed.id)
      data?.onAutoClose?.(removed)
    },
  }
}

const publish =
  (send: (message: Title, data?: ExternalToast) => number | string) =>
  (message: Title, data?: ExternalToast): number | string | undefined =>
    enqueueToast(() => {
      const id = send(message, withQueue(data, finishToast))
      return id
    })

/**
 * 直接关掉：`dismiss(id)` 只关指定那条，`dismiss()` 关掉全部。
 * sonner 那边 `dismiss` 会把提示标成 `delete`，挂载着的 Toast 随后自己调 `onDismiss`，
 * 所以这里再调一次 `finishToast(id)` 会和那个回调重复——靠 `finishToast` 的幂等（名额已经删过就返回）兜住，
 * 不会多补一条。
 * 关指定那条：腾出它的名额，队首补位。
 * 关全部：先把名额和排队都清掉再关——反过来先逐个结算的话，`finishToast` 会从队里补位、
 * 把排着的提示真的投递出去，而那时 `sonner.dismiss()` 已经过了，没人再关它们：
 * 「关掉全部」之后屏幕上反而会多出几条，而且它们不在名额账本里，接着弹会超过上限。
 */
const dismiss = (id?: number | string) => {
  if (id !== undefined) {
    sonner.dismiss(id)
    finishToast(id)
    return id
  }
  clearToastQueue()
  sonner.dismiss()
  return undefined
}

export const toast = Object.assign(publish(sonner), {
  success: publish(sonner.success),
  error: publish(sonner.error),
  warning: publish(sonner.warning),
  info: publish(sonner.info),
  message: publish(sonner.message),
  dismiss,
  // 单测读历史用，不投递
  getHistory: sonner.getHistory,
})

export type { ExternalToast }
