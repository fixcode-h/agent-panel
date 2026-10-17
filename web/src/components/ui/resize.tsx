import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 可拖动的栏宽：记在本机，下次打开还是这个宽度 */
export function usePaneWidth(key: string, initial: number, min: number, max: number) {
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)))
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(`pane:${key}`))
      return v ? clamp(v) : initial
    } catch {
      return initial
    }
  })
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
    max,
  }
}

/**
 * 栏左边缘的拖动条：往左拖变宽，往右拖变窄；双击恢复默认宽度。
 * 拖动时盖一层透明遮罩，免得鼠标经过效果区的 iframe、画布时丢掉事件
 */
export function ResizeHandle({ pane, label }: { pane: ReturnType<typeof usePaneWidth>; label?: string }) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)
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
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        pane.set(start.current.w + (start.current.x - e.clientX))
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        const w = Math.min(pane.max, Math.max(pane.min, start.current.w + (start.current.x - e.clientX)))
        start.current = null
        setDragging(false)
        pane.save(Math.round(w))
      }}
      onDoubleClick={pane.reset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10
        if (e.key === 'ArrowLeft') pane.set(pane.width + step)
        else if (e.key === 'ArrowRight') pane.set(pane.width - step)
        else return
        e.preventDefault()
      }}
      onKeyUp={() => pane.save(pane.width)}
      className="group absolute inset-y-0 -left-[3px] z-20 w-[6px] cursor-col-resize outline-none"
    >
      <span
        className={cn(
          'absolute inset-y-0 left-[2px] w-[2px] transition-colors',
          dragging ? 'bg-accent' : 'group-hover:bg-accent/60 group-focus-visible:bg-accent/60',
        )}
      />
      {dragging && <span className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  )
}
