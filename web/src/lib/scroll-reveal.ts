/**
 * 滚动条只在「正在滚动的那一块」上显示，停下一会儿自动隐藏（用户要求）。
 *
 * 原来滚动条一直画着（Claude Code 配色）或鼠标进到区域就显（thin-scroll），嵌套的滚动区
 * （会话栏外层 + 里面的 MCP 工具列表）会同时出现两条。改成按 scroll 事件给真正滚动的元素
 * 挂 data-scrolling，样式只给挂了它的元素画滑块；嵌套时内层滚到头、外层接着滚，才轮到外层显示。
 * scroll 不冒泡，所以在 document 上用捕获阶段统一监听，任何可滚动区域都不用自己接。
 */

/** 停止滚动多久后隐藏 */
export const SCROLL_HIDE_MS = 900

const ATTR = 'data-scrolling'

export function installScrollReveal(doc: Document = document): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>()
  const onScroll = (e: Event) => {
    // 页面本身滚动时事件目标是 document，滚动条在 html 上
    const el = e.target === doc ? doc.documentElement : e.target
    if (!(el instanceof Element)) return
    // 同一时间只显示一条：别的区域还在倒计时的立刻收掉
    for (const [other, timer] of timers) {
      if (other === el) continue
      clearTimeout(timer)
      other.removeAttribute(ATTR)
      timers.delete(other)
    }
    if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, '')
    clearTimeout(timers.get(el))
    timers.set(
      el,
      setTimeout(() => {
        el.removeAttribute(ATTR)
        timers.delete(el)
      }, SCROLL_HIDE_MS),
    )
  }
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true })
    for (const [el, timer] of timers) {
      clearTimeout(timer)
      el.removeAttribute(ATTR)
    }
    timers.clear()
  }
}
