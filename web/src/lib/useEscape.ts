import { useEffect, useRef } from 'react'

/** 打开着的抽屉、面板按 Esc 关闭（有下拉、菜单等弹出层开着时先让它们处理） */
export function useEscape(active: boolean, close: () => void) {
  const fn = useRef(close)
  fn.current = close
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role=dialog][data-state=open]')) return
      fn.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}
