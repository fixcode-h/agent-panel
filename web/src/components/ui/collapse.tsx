import { useEffect, useState } from 'react'

/** 收起动画放完再卸载内容：比 --dur-base（200ms）多留一点 */
const UNMOUNT_MS = 220

/**
 * 展开收起的高度过渡（照 Claude Code：高度 200ms 走 snap 曲线，内容稍后淡入）。
 * 用 grid-template-rows 0fr → 1fr 过渡，不用量内容高度；收起时内容先留着，动画放完再卸载，
 * 平时收着的内容不渲染（长的工具输出不白占内存）。一开始就是展开的不播动画。
 * 系统开了「减少动态效果」时时长令牌是 1ms，等于直接跳变
 */
export function Collapse({
  open,
  className,
  children,
}: {
  open: boolean
  className?: string
  children: React.ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      // 先以收起状态画一帧，下一帧再展开，过渡才有起点
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(r)
    }
    setShown(false)
    const timer = setTimeout(() => setMounted(false), UNMOUNT_MS)
    return () => clearTimeout(timer)
  }, [open])
  if (!mounted) return null
  return (
    <div data-collapse={shown ? 'open' : 'closed'} className="collapse-grid" inert={!open}>
      {/* 外边距、边框写在最里层：写在被压成 0 高的那层上会露出来 */}
      <div className="min-h-0 overflow-hidden">
        <div className={className}>{children}</div>
      </div>
    </div>
  )
}
