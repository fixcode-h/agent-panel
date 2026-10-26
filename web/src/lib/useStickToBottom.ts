import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** 默认的贴底判定距离：离底部不到这么多像素就算还在看最新的内容 */
export const STICK_THRESHOLD = 40

/** 判定的纯逻辑，方便单独测：内容不足一屏（没有滚动条）也算贴底，不会平白把状态判成「用户翻上去了」 */
export function nearBottom(
  box: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = STICK_THRESHOLD,
) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold
}

/**
 * 一次滚动事件之后还跟不跟着底部走。只有「真的往上滚了」（scrollTop 变小）才算用户翻上去：
 * 我们自己贴底时设的 scrollTop，滚动事件要到下一帧才派发，这中间流式输出又插进一张工具卡片、一大段文字，
 * 事件里读到的就是「离底部很远」——光看离底部多远会把这种情况误判成用户翻上去，之后就再也不跟了
 * （偶发的「对话进行中不回到底部」就是这么来的）。往下滚、位置没变只是内容变高，都保持原来的状态。
 */
export function stillPinned(
  box: { scrollTop: number; scrollHeight: number; clientHeight: number },
  prevTop: number,
  pinned: boolean,
  threshold = STICK_THRESHOLD,
) {
  if (nearBottom(box, threshold)) return true
  return box.scrollTop < prevTop - 1 ? false : pinned
}

/** 容器挂上时停在哪一端：底部是「看最新内容」，顶部是「先看第一块内容」 */
export type ScrollStart = 'bottom' | 'top'

/**
 * 贴底滚动：打开时就停在最新内容，之后内容变高跟着走，用户往上翻看时不打扰（滚回底部附近再接着跟）。
 *
 * 只在消息长度变化时滚不够：
 * - 弹窗（Radix 的 Portal + Presence）里的滚动容器比父组件晚一次提交才挂上，父组件布局副作用跑的时候
 *   `ref.current` 还是 null，之后再没有触发点。所以用回调 ref 把节点放进 state，挂上后再贴底；
 * - 挂载动画、Markdown、工具卡片、图片都是后来才渲染出高度的。所以首帧滚一次、下一帧再补一次，
 *   另外用 `ResizeObserver` 盯住容器和内容块，布局稳定（变高了）再把底部对齐。
 *
 * 日志这类容器的高度是固定的、内容只是一段文本，所以除了 childList 还要听 characterData：
 * React 更新文本子节点时只改 nodeValue，不增删节点，光听 childList 一次都收不到。
 *
 * @param key 换看另一个对象（另一条子任务、另一次运行、另一个任务状态）时传不同的值：会重新贴底，不沿用上一个的「翻上去了」
 * @param active 容器当前没在显示内容（同一个容器切到流程图视图）时传 false：停止跟着内容滚，也不记位置。
 *   变回 true 时重新贴底——切回对话视图就该停在最新一行
 * @param startAt 挂上容器时停在哪一端。默认 'bottom'（对话、日志这类看最新内容）；
 *   'top' 是「先看第一块内容」——最上面那块本身就说明这里是什么（子任务窗口的「派给它的要求」）。
 *   停顶部时不贴底、新输出也不把人拽走（正在读的要求会被顶掉），用户自己滚到底部附近才恢复跟随
 */
export function useStickToBottom<K = unknown>(
  key?: K,
  threshold = STICK_THRESHOLD,
  active = true,
  startAt: ScrollStart = 'bottom',
) {
  const box = useRef<HTMLElement | null>(null)
  // 节点挂上、换掉时都要重跑贴底，所以同时留一份在 state 里
  const [node, setNode] = useState<HTMLElement | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    box.current = el
    setNode(el)
  }, [])
  // 用户把内容翻上去了就不再拽回底部
  const pinned = useRef(true)
  // 上一次看到的 scrollTop：判断这次滚动是不是往上
  const lastTop = useRef(0)
  // 离开底部（可以显示「回到底部」）：只在真的变了时才 setState，滚动过程中不反复重渲染
  const [away, setAway] = useState(false)
  const awayRef = useRef(false)
  const markAway = useCallback((v: boolean) => {
    if (awayRef.current === v) return
    awayRef.current = v
    setAway(v)
  }, [])

  const onScroll = useCallback(() => {
    const el = box.current
    if (!el) return
    pinned.current = stillPinned(el, lastTop.current, pinned.current, threshold)
    lastTop.current = el.scrollTop
    markAway(!nearBottom(el, threshold))
  }, [threshold, markAway])

  // 主动回到最新内容：点了「回到底部」，或者刚发出一条消息、点了某一步时接着看最新的
  const pin = useCallback(() => {
    pinned.current = true
    const el = box.current
    if (el) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    }
    markAway(false)
  }, [markAway])

  // 主动停在某段内容上（点了任务里的某一步），别让下一段输出把它顶走
  const unpin = useCallback(() => {
    pinned.current = false
  }, [])

  useLayoutEffect(() => {
    if (!node || !active) return
    // 停在顶部时不贴底：最上面那块（子任务窗口的「派给它的要求」）才是打开时要看的内容。
    // 新输出进来也不拽到底部，否则用户正在读的要求会被顶走；滚到底部附近由 onScroll 恢复跟随
    pinned.current = startAt !== 'top'
    if (startAt === 'top') {
      node.scrollTop = 0
      lastTop.current = 0
    }
    markAway(startAt === 'top' ? !nearBottom(node, threshold) : false)
    const stick = () => {
      if (!pinned.current) return
      node.scrollTop = node.scrollHeight
      lastTop.current = node.scrollTop
    }
    stick()
    let raf = 0
    let raf2 = 0
    raf = requestAnimationFrame(() => {
      stick()
      raf2 = requestAnimationFrame(stick)
    })
    // 内容变化走每帧合并：流式输出和日志是逐段更新文本的，每次都读 scrollHeight 会反复触发同步布局
    let pending = 0
    const schedule = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        stick()
      })
    }

    // 容器自己变矮（窗口拉伸）要贴回底部；内容块变高（流式输出、懒渲染、图片加载）也要跟过去
    const ro = new ResizeObserver(schedule)
    const watched = new Set<Element>()
    const watch = (el: Element) => {
      if (watched.has(el)) return
      ro.observe(el)
      watched.add(el)
    }
    watch(node)
    const watchChildren = () => {
      for (const child of node.children) watch(child)
    }
    watchChildren()
    // 新的一轮回复是后来插进来的内容块，也要盯上
    const mo = new MutationObserver(() => {
      watchChildren()
      schedule()
    })
    mo.observe(node, { childList: true, subtree: true, characterData: true })

    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(raf2)
      cancelAnimationFrame(pending)
      ro.disconnect()
      mo.disconnect()
    }
  }, [node, key, threshold, active, startAt, markAway])

  // el 给需要在容器里定位子元素（点任务进度里的某一步）的调用方用
  return { ref, el: box, onScroll, away, toBottom: pin, pin, unpin }
}
