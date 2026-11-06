import { useCallback, useEffect, useState } from 'react'

/**
 * 页签条放不下时的横向滚动（TabBar 用）。
 * 页签区为了好看把滚动条藏了（scrollbar-width: none），只有触控板能横着划；鼠标滚轮是竖向的，
 * 用户就看不到被截掉的页签（设置 → Markdown 样式的小节菜单）。这里做三件事：
 * 1. 竖向滚轮换成横向滚动（只在放不下时接管，放得下就不拦，外层照常滚）；
 * 2. 报告左右还能不能滚，TabBar 据此显示两端的箭头按钮和渐隐；
 * 3. scrollBy 给箭头按钮用，一次滚大半个可见宽度。
 */
export function useTabScroll() {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ overflow: false, start: false, end: false })

  useEffect(() => {
    if (!el) return
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth
      // 留 1px 余量：缩放后 scrollLeft 是小数，到头时可能差零点几
      const next = { overflow: max > 1, start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 }
      setEdges((p) => (p.overflow === next.overflow && p.start === next.start && p.end === next.end ? p : next))
    }
    // React 的 onWheel 是被动监听，拦不住外层跟着滚，所以挂原生事件
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      const max = el.scrollWidth - el.clientWidth
      if (max <= 1) return
      e.preventDefault()
      // deltaMode 1 是按行滚（Firefox 鼠标），换成像素
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    el.addEventListener('wheel', wheel, { passive: false })
    // 页签增减、条变宽变窄都要重算：观察容器本身和每个页签
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    const mo = new MutationObserver(() => {
      for (const c of el.children) ro.observe(c)
      measure()
    })
    mo.observe(el, { childList: true })
    return () => {
      el.removeEventListener('scroll', measure)
      el.removeEventListener('wheel', wheel)
      ro.disconnect()
      mo.disconnect()
    }
  }, [el])

  const scrollBy = useCallback(
    (dir: -1 | 1) => el?.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.7), behavior: 'smooth' }),
    [el],
  )

  return { ref: setEl, ...edges, scrollBy }
}

/**
 * 选中的页签被挤到可见区外时，把页签区横向滚到能看见它（设置小节菜单跟着内容滚动换高亮）。
 * 只滚页签区自己，不用 scrollIntoView：它会顺带滚外层，打断设置内容区正在进行的平滑滚动。
 */
export function revealTab(tab: HTMLElement) {
  const list = tab.closest<HTMLElement>('[role="tablist"]')
  if (!list || list.scrollWidth <= list.clientWidth) return
  const pad = 24
  // 页签区是 relative，offsetLeft 就是相对它的位置
  const left = tab.offsetLeft
  const right = left + tab.offsetWidth
  if (left - pad < list.scrollLeft) list.scrollTo({ left: Math.max(0, left - pad), behavior: 'smooth' })
  else if (right + pad > list.scrollLeft + list.clientWidth)
    list.scrollTo({ left: right + pad - list.clientWidth, behavior: 'smooth' })
}
