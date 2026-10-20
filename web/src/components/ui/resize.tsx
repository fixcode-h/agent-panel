import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 设置里的内容宽度（--content-w）：中间至少要留出这么多，输入框才不会跟着栏宽变窄 */
export function contentPaneWidth() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-w'))
  return v > 0 ? v : 1000
}

/** 可拖动的栏宽：记在本机，下次打开还是这个宽度；上限可以按窗口宽度算 */
export function usePaneWidth(key: string, initial: number, min: number, max: number | (() => number)) {
  const limit = () => Math.max(min, typeof max === 'function' ? max() : max)
  const clamp = (n: number) => Math.round(Math.min(limit(), Math.max(min, n)))
  // 存过的宽度原样恢复：上限只限制拖动，不改变已经习惯的布局（窗口变窄时也先保持）
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(`pane:${key}`))
      return v || initial
    } catch {
      return initial
    }
  })
  /** 正在拖动：拖动时不要给宽度加过渡，否则跟不上鼠标 */
  const [dragging, setDragging] = useState(false)
  const save = (n: number) => {
    try {
      localStorage.setItem(`pane:${key}`, String(n))
    } catch {}
  }
  return {
    width,
    set: (n: number) => setWidth(clamp(n)),
    save,
    reset: () => (setWidth(initial), save(initial)),
    min,
    max: limit(),
    dragging,
    setDragging,
  }
}

/**
 * 栏边缘的拖动条：左栏（side="right"）往右拖变宽，右栏（默认）往左拖变宽；双击恢复默认宽度。
 * 拖动时盖一层透明遮罩，免得鼠标经过效果区的 iframe、画布时丢掉事件
 */
export function ResizeHandle({
  pane,
  label,
  side = 'left',
  className,
}: {
  pane: ReturnType<typeof usePaneWidth>
  label?: string
  /** 拖动条在哪一侧：right 用于左边的侧栏 */
  side?: 'left' | 'right'
  className?: string
}) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const dir = side === 'right' ? 1 : -1
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? t('拖动调整宽度')}
      aria-valuenow={pane.width}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      title={t('拖动调整宽度，双击恢复默认')}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: pane.width }
        pane.setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        pane.set(start.current.w + dir * (e.clientX - start.current.x))
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        const w = Math.min(pane.max, Math.max(pane.min, start.current.w + dir * (e.clientX - start.current.x)))
        start.current = null
        pane.setDragging(false)
        pane.save(Math.round(w))
      }}
      onDoubleClick={pane.reset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10
        if (e.key === 'ArrowLeft') pane.set(pane.width - dir * step)
        else if (e.key === 'ArrowRight') pane.set(pane.width + dir * step)
        else return
        e.preventDefault()
      }}
      onKeyUp={() => pane.save(pane.width)}
      className={cn(
        'group absolute inset-y-0 z-20 w-[6px] cursor-col-resize outline-none',
        side === 'right' ? '-right-[3px]' : '-left-[3px]',
        className,
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 w-[2px] transition-colors',
          side === 'right' ? 'right-[2px]' : 'left-[2px]',
          pane.dragging ? 'bg-accent' : 'group-hover:bg-accent/60 group-focus-visible:bg-accent/60',
        )}
      />
      {pane.dragging && <span className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  )
}
