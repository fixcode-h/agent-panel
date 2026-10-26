/**
 * 提示的排队：同屏只留几条，其余排着等前面的消失后再出现。
 *
 * 不用 sonner 的 `visibleToasts`：它只是把超出的那几条设成 `data-visible="false"` 藏起来，
 * 它们照样占着数组、照样走 4 秒计时，到期直接丢掉、后面的不补位。
 * 所以「同屏几条、其余排队」只能自己控制投递时机：`web/src/lib/toast.ts` 每次弹提示前先问这里
 * 能不能投递，sonner 真把那一条移除时（到期 / 手动关 / 划走 / dismiss）再回来补位。
 *
 * 排队的那条被补位时是**重新投递**（还是一样的内容、一样的动作按钮），不保存已经画出来的 DOM；
 * 所以等待期间它不占名额、也不会因为计时到点凭空消失。
 */

/**
 * 同屏最多几条。项目里的提示绝大多数是一句话（错误提示不带 `<pre>` 时一行多），
 * 4 条约占右上角 320px，1080 高的窗口还剩 2/3 露出对话；再多就会盖住正在看的内容。
 * 批量操作连发十几条时，超出的按先后排队，不会一瞬间刷满半屏。
 */
export const TOAST_VISIBLE_LIMIT = 4

/** 已投递、还没被 sonner 移除的提示 id（投递顺序，不是屏幕顺序） */
const shown = new Set<number | string>()
/** 排着队的投递动作，先来先走 */
const waiting: Array<() => number | string> = []

function deliver(publish: () => number | string) {
  const id = publish()
  shown.add(id)
  return id
}

/**
 * 投递一条提示：名额没满就现在弹，满了排到队尾、等前面腾出位置。
 * 排队时没有 id 可返回——返回值本来也没人用（sonner 的 id 只用于更新 / 关闭同一个提示）。
 */
export function enqueueToast(publish: () => number | string): number | string | undefined {
  if (shown.size < TOAST_VISIBLE_LIMIT) return deliver(publish)
  waiting.push(publish)
  return undefined
}

/**
 * 一条提示真的从屏幕上没了（sonner 的 onAutoClose / onDismiss 都会走到这里，重复调用只算一次）：
 * 腾出名额，把队首那条弹出来。
 */
export function finishToast(id: number | string) {
  // 不是这里投递的、或者已经结算过：不补位，否则同一个名额会被算掉两次
  if (!shown.delete(id)) return
  const next = waiting.shift()
  if (next) deliver(next)
}

/** 当前队列快照：单测和排查用 */
export const toastQueueState = () => ({ shown: [...shown], waiting: waiting.length })

/**
 * 清空：屏幕上占着的名额和排队的全丢掉。
 * `toast.dismiss()`（「关掉所有提示」）和单测都用它——已经关掉了却还排着队的，
 * 之后会莫名其妙弹出来。
 */
export const clearToastQueue = () => {
  shown.clear()
  waiting.length = 0
}
