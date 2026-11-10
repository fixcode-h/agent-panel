// 输入框上方的悬浮层：等你确认、等你操作、流程没走完这类提醒叠在这里，浮在消息上面。
// 原来它们排在停靠区里，一出现就把输入框往下顶、把消息区挤矮（用户 2026-11-10 要求统一改成悬浮）。
import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * 放在停靠区最前面（或输入框那一块的最前面）：自己是零高度的锚点，不占布局；
 * 里面的卡片从锚点往上叠，最后一个离输入框最近。没有卡片时什么都看不到。
 * 提问（QuestionPanel）不放进来：它是换掉输入框的，不是浮在上面的。
 */
export function FloatAbove({
  children,
  className,
  onHeight,
}: {
  children?: React.ReactNode
  /** 浮层的内边距：和所在停靠区的左右内边距一致，卡片才和输入框对齐 */
  className?: string
  /** 浮层现在多高（没有卡片是 0）：消息区按它在底部多留一段，盖住的最后几行还能滚出来看 */
  onHeight?: (h: number) => void
}) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  // 最高只到消息区的上沿：卡片叠得再多也不盖到标题栏上去，超出的在浮层里滚
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    if (!anchor) return
    // 上面那块消息区：从锚点往外找最近的一个 data-float-bound（ConversationShell 的消息区自带）
    let bound: Element | null = null
    for (let n = anchor.parentElement; n && !bound; n = n.parentElement) bound = n.querySelector('[data-float-bound]')
    if (!bound) return
    const read = () =>
      setRoom(Math.max(0, Math.round(anchor.getBoundingClientRect().top - bound.getBoundingClientRect().top)))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(bound)
    return () => ro.disconnect()
  }, [anchor])
  useLayoutEffect(() => {
    if (!el || !onHeight) return
    const read = () => onHeight(Math.round(el.getBoundingClientRect().height))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      ro.disconnect()
      onHeight(0)
    }
  }, [el, onHeight])
  // 叠得比消息区还高时停在最下面：离输入框最近的那张最要紧，不能被裁在外面。只在内容高度变了时贴底，
  // 用户自己往上滚着看的时候不拽回来；每次渲染后都比一下（内容被 max-height 截住后，容器的尺寸变化听不到）
  const lastScroll = useRef(0)
  useLayoutEffect(() => {
    if (!el || el.scrollHeight === lastScroll.current) return
    lastScroll.current = el.scrollHeight
    el.scrollTop = el.scrollHeight
  })
  return (
    <div ref={setAnchor} className="relative h-0 shrink-0">
      <div
        ref={setEl}
        data-float-above=""
        style={room ? { maxHeight: room } : undefined}
        // 容器本身不接鼠标：卡片之间、两侧的空白要能点到下面的消息。上面留一点空，滚动裁边时不切掉卡片的投影
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-y-auto thin-scroll *:first:mt-2 *:shrink-0 *:pointer-events-auto',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
