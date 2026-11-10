/**
 * 折叠的记忆：每一轮收尾到哪儿（切段）、用户点开 / 收起了哪一段。都按 key 记在模块级的 Map 里，
 * 组件重新挂载时拿得到；各留最近 500 条，长时间开着页面不会只涨不跌
 */

/** 最多记多少条：超出时丢掉最早记下的（Map 按插入顺序遍历） */
const CAP = 500

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  while (map.size > CAP) map.delete(map.keys().next().value!)
}

/**
 * 这一轮收尾了：记下折到第几条消息。
 * 之后子对话回报、后台命令结果进来把 CLI 重新拉起来时，前面这段按这个位置始终折叠，新过程接在后面
 */
export function markFold(cuts: number[], len: number) {
  return len > (cuts.at(-1) ?? 0) ? [...cuts, len] : cuts
}

/**
 * 每一轮收尾到哪儿：按这一轮第一条消息的 id 记在内存里。
 * 消息列表滚到早的段被裁掉又回来、切到别的页签又回来时会重新挂载组件，记在这里就不用又从展开状态开始
 */
const turnCuts = new Map<string, number[]>()

/** 这一轮已经折到哪儿（没折过是空的） */
export function foldCuts(key: string) {
  return turnCuts.get(key) ?? []
}

/** 这一轮又收尾了一次：往后记一段，同一轮不会重复记同一位置 */
export function addFoldCut(key: string, len: number) {
  const cuts = markFold(foldCuts(key), len)
  remember(turnCuts, key, cuts)
  return cuts
}

/**
 * 用户点开 / 收起某一段的选择：按「这一轮 + 第几段」记在内存里。
 * 来了新内容重新分段、切到别的页签又回来、消息被裁掉再恢复时组件会重新挂载，
 * 不记住的话每次都会回到默认的收起状态，用户点开过的那段又缩回去了
 */
const segOpen = new Map<string, boolean>()

/** 这一段现在是展开的（没点过就按 fallback：普通对话收起，和收尾后的默认状态一致；AI 分析窗口里默认展开） */
export function segOpenOf(id: string, fallback = false) {
  return segOpen.get(id) ?? fallback
}

/** 点了这一段的开关：记下新的状态并返回，界面直接用这个值 */
export function toggleSegOpen(id: string, fallback = false) {
  const next = !segOpenOf(id, fallback)
  remember(segOpen, id, next)
  return next
}

/**
 * 按记下的位置把这一轮分成几段：前面的段都已经收尾（始终折叠），最后一段是这次新来的内容。
 * 最后一段可能是空的（收尾后还没有新内容）；记下的位置超出现在的消息数时按现有消息切，不丢消息
 */
export function splitFolds<T>(msgs: T[], cuts: number[]): T[][] {
  const parts: T[][] = []
  let from = 0
  for (const cut of cuts) {
    const to = Math.min(cut, msgs.length)
    if (to <= from) continue
    parts.push(msgs.slice(from, to))
    from = to
  }
  parts.push(msgs.slice(from))
  return parts
}
