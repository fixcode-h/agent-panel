import { useEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'

/** 滑块最短多高，和 index.css 里 thin-scroll 的 min-height 一致 */
const MIN_THUMB = 40

/**
 * 画在旁边那条滚动槽里的滚动条：给自己的原生滚动条藏起来的区域用。
 *
 * 会话栏浮在对话右边，消息区的滚动条在它右边那一条槽（RAIL_GUTTER）里；会话栏自己再画一条原生滚动条，
 * 两条挨着竖在一起（用户要求合成一根）。所以会话栏藏掉原生的，滑块改画到同一条槽里。
 * 槽里显示谁的滑块看鼠标在哪块（用户要求，不自动隐藏）：鼠标进会话栏（或焦点进去）显示会话栏的，
 * 回到对话正文显示消息区的；在槽里移动不切换，不然想去拖会话栏的滑块时一进槽就换成了消息区的。
 * 当前是哪块写在外层 [data-scroll-pair] 的 data-scroll-focus 上，index.css 按它在会话栏那一侧时藏掉消息区的滑块。
 * 只管这两块互斥：会话栏和对话正文里面嵌套的滚动区（MCP 工具列表等）照常显示自己的滚动条。
 */
export function RailScrollbar({
  target,
  width,
  className,
}: {
  /** 原生滚动条藏起来的滚动区 */
  target: RefObject<HTMLElement | null>
  /** 槽的宽度：滑块画在目标区域右边紧挨着的这一条里 */
  width: number
  className?: string
}) {
  const [shown, setShown] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [geo, setGeo] = useState({ top: 0, height: 0 })
  const drag = useRef<{ y: number; scrollTop: number } | null>(null)
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = target.current
    if (!el) return
    const measure = () => {
      const { scrollHeight, clientHeight, scrollTop } = el
      const next = { top: 0, height: 0 }
      if (scrollHeight > clientHeight + 1) {
        next.height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight)
        next.top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - next.height)
      }
      // 会话栏里的数字一直在刷新，没变就不重画
      setGeo((g) => (g.top === next.top && g.height === next.height ? g : next))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // 内容变多变少（展开 MCP 工具列表）不一定改变滚动区自己的尺寸，滑块长短要跟着重算
    const mo = new MutationObserver(measure)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
      mo.disconnect()
    }
  }, [target])

  // 鼠标 / 焦点在哪块：会话栏（本组件挂在它里面，槽在它右边）还是旁边的对话正文
  useEffect(() => {
    const region = slot.current?.parentElement
    const pair = region?.closest<HTMLElement>('[data-scroll-pair]')
    if (!region || !pair) return
    const set = (on: boolean) => {
      pair.dataset.scrollFocus = on ? 'rail' : 'main'
      setShown(on)
    }
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return // 拖着滑块（或选文字）时不切换
      const node = e.target as Node
      if (region.contains(node)) return set(true)
      // 在会话栏右边那条槽里：保持现状，方便去拖当前显示的滑块
      const r = region.getBoundingClientRect()
      if (e.clientX >= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return
      set(false)
    }
    const onFocus = (e: FocusEvent) => set(region.contains(e.target as Node))
    set(false)
    pair.addEventListener('pointermove', onMove, { passive: true })
    pair.addEventListener('focusin', onFocus)
    return () => {
      pair.removeEventListener('pointermove', onMove)
      pair.removeEventListener('focusin', onFocus)
      delete pair.dataset.scrollFocus
    }
  }, [])

  const visible = (shown || dragging) && geo.height > 0
  return (
    <div
      ref={slot}
      aria-hidden
      className={cn('pointer-events-none absolute inset-y-0 left-full', className)}
      style={{ width }}
    >
      <div
        className={cn(
          'absolute inset-x-1 rounded-full transition-[background-color] duration-150',
          visible
            ? 'pointer-events-auto bg-[var(--scroll-thumb)] hover:bg-[var(--scroll-thumb-hover)]'
            : 'bg-transparent',
          dragging && 'bg-[var(--scroll-thumb-hover)]',
        )}
        style={{ top: geo.top, height: geo.height }}
        data-rail-thumb={visible ? 'shown' : 'hidden'}
        onPointerDown={(e) => {
          const el = target.current
          if (!el || !visible) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, scrollTop: el.scrollTop }
          setDragging(true)
        }}
        onPointerMove={(e) => {
          const el = target.current
          const d = drag.current
          if (!el || !d) return
          const track = el.clientHeight - geo.height
          if (track <= 0) return
          el.scrollTop = d.scrollTop + ((e.clientY - d.y) * (el.scrollHeight - el.clientHeight)) / track
        }}
        onPointerUp={() => {
          drag.current = null
          setDragging(false)
        }}
        onPointerCancel={() => {
          drag.current = null
          setDragging(false)
        }}
      />
    </div>
  )
}
