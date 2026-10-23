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
 * 贴底滚动：打开时就停在最新内容，之后内容变高跟着走，用户往上翻看时不打扰（滚回底部附近再接着跟）。
 *
 * 只在消息长度变化时滚不够：
 * - 弹窗（Radix 的 Portal + Presence）里的滚动容器比父组件晚一次提交才挂上，父组件布局副作用跑的时候
 *   `ref.current` 还是 null，之后再没有触发点。所以用回调 ref 把节点放进 state，挂上后再贴底；
 * - 挂载动画、Markdown、工具卡片、图片都是后来才渲染出高度的。所以首帧滚一次、下一帧再补一次，
 *   另外用 `ResizeObserver` 盯住容器和内容块，布局稳定（变高了）再把底部对齐。
 *
 * @param key 换看另一个对象（另一条子任务、另一次运行）时传不同的值：会重新贴底，不沿用上一个的「翻上去了」
 */
export function useStickToBottom<K = unknown>(key?: K, threshold = STICK_THRESHOLD) {
  const box = useRef<HTMLDivElement | null>(null)
  // 节点挂上、换掉时都要重跑贴底，所以同时留一份在 state 里
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    box.current = el
    setNode(el)
  }, [])
  // 用户把内容翻上去了就不再拽回底部
  const pinned = useRef(true)

  const onScroll = useCallback(() => {
    const el = box.current
    if (el) pinned.current = nearBottom(el, threshold)
  }, [threshold])

  useLayoutEffect(() => {
    if (!node) return
    pinned.current = true
    const stick = () => {
      if (pinned.current) node.scrollTop = node.scrollHeight
    }
    stick()
    let raf = 0
    let raf2 = 0
    raf = requestAnimationFrame(() => {
      stick()
      raf2 = requestAnimationFrame(stick)
    })

    // 容器自己变矮（窗口拉伸）要贴回底部；内容块变高（流式输出、懒渲染、图片加载）也要跟过去
    const ro = new ResizeObserver(stick)
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
      stick()
    })
    mo.observe(node, { childList: true })

    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(raf2)
      ro.disconnect()
      mo.disconnect()
    }
  }, [node, key, threshold])

  return { ref, onScroll }
}
