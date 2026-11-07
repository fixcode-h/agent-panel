import { useEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'

/** 滑块最短多高，和 index.css 里 thin-scroll 的 min-height 一致 */
const MIN_THUMB = 40

/**
 * 画在旁边那条滚动槽里的滚动条：给自己的原生滚动条藏起来的区域用。
 *
 * 会话栏浮在对话右边，消息区的滚动条在它右边那一条槽（RAIL_GUTTER）里；会话栏自己再画一条原生滚动条，
 * 两条挨着竖在一起（用户要求合成一根、哪个在滚显示哪个）。所以会话栏藏掉原生的，滑块改画到同一条槽里。
 * 显隐跟原生滚动条走同一套：看目标元素上 scroll-reveal 挂的 data-scrolling，滚动时显示、停下隐藏；
 * scroll-reveal 同一时间只给一个区域挂这个标记，所以槽里任何时候只有一根滑块。
 * 隐藏时不接鼠标，底下消息区的原生滚动条照常能拖。
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

  useEffect(() => {
    const el = target.current
    if (!el) return
    const measure = () => {
      const { scrollHeight, clientHeight, scrollTop } = el
      if (scrollHeight <= clientHeight + 1) return setGeo({ top: 0, height: 0 })
      const height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight)
      const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height)
      setGeo({ top, height })
    }
    const sync = () => setShown(el.hasAttribute('data-scrolling'))
    measure()
    sync()
    el.addEventListener('scroll', measure, { passive: true })
    const mo = new MutationObserver(sync)
    mo.observe(el, { attributes: true, attributeFilter: ['data-scrolling'] })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      mo.disconnect()
      ro.disconnect()
    }
  }, [target])

  const visible = (shown || dragging) && geo.height > 0
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-y-0 left-full', className)} style={{ width }}>
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
