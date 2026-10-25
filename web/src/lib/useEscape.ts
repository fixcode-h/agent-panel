import { useEffect, useRef } from 'react'

/**
 * 打开着的抽屉、面板按 Esc 关闭（有下拉、菜单等弹出层开着时先让它们处理）。
 *
 * capture：盖在别的东西上面的最上层用它。各自的 keydown 都挂在 window 上、都不拦默认，
 * 同一键会串着触发所有还开着的 hook（子对话里的运行视图、计划面板不会因为上面又盖了一层就退出）；
 * capture 阶段先于它们执行，处理完就 stopPropagation，这次 Esc 归最上层。
 */
export function useEscape(active: boolean, close: () => void, capture = false) {
  const fn = useRef(close)
  fn.current = close
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role=dialog][data-state=open]')) return
      if (capture) e.stopPropagation()
      fn.current()
    }
    window.addEventListener('keydown', onKey, capture)
    return () => window.removeEventListener('keydown', onKey, capture)
  }, [active, capture])
}
