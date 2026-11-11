import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'

/** all：Ctrl+Enter，把这个值填进选中的每一格 */
export type CellMove = 'down' | 'right' | 'left' | 'up' | 'all'

/**
 * 格子里的文字编辑框：盖在格子上，比格子宽时往右长；Enter 确认往下、Tab 往右、Shift 反向，
 * Alt+Enter 换行，Ctrl+Enter 填进选中的每一格，Esc 放弃，点到别处算确认（和表格软件一样）
 */
export function CellEditor({ init, onDone }: { init: string; onDone: (v: string | null, move?: CellMove) => void }) {
  const [v, setV] = useState(init)
  const ref = useRef<HTMLTextAreaElement>(null)
  const ended = useRef(false)
  const end = (value: string | null, move?: CellMove) => {
    if (ended.current) return
    ended.current = true
    onDone(value, move)
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // 双击 / F2 进来时光标放到末尾；打字进来时已经只有那一个字
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const lines = v.split('\n').length
  return (
    <textarea
      ref={ref}
      aria-label={t('编辑单元格')}
      value={v}
      spellCheck={false}
      rows={Math.min(lines, 8)}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => end(v)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') return void (e.preventDefault(), end(null))
        if (e.key === 'Enter' && e.altKey) {
          e.preventDefault()
          const el = e.currentTarget
          const at = el.selectionStart
          setV(v.slice(0, at) + '\n' + v.slice(el.selectionEnd))
          requestAnimationFrame(() => el.setSelectionRange(at + 1, at + 1))
          return
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return void (e.preventDefault(), end(v, 'all'))
        if (e.key === 'Enter') return void (e.preventDefault(), end(v, e.shiftKey ? 'up' : 'down'))
        if (e.key === 'Tab') return void (e.preventDefault(), end(v, e.shiftKey ? 'left' : 'right'))
      }}
      className="absolute top-0 left-0 z-3 min-h-full w-max min-w-full max-w-[480px] resize-none border-0 bg-(--sheet-bg) px-2 font-[inherit] text-[length:inherit] leading-[inherit] text-fg shadow-[inset_0_0_0_2px_var(--accent),0_4px_12px_rgb(0_0_0/0.12)] outline-none"
      style={{ fieldSizing: 'content' } as React.CSSProperties}
    />
  )
}
