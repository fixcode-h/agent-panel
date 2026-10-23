import { useEffect, useRef } from 'react'

/**
 * 输入框上方的命令菜单（斜杠命令、@ 项目文件）用同一套滚动和高度规则：
 *
 * - 选中项跟着 ↑↓ 滚进可视区。菜单限高后超出的部分靠滚动看，不跟着滚的话最后几项被菜单边界裁掉，
 *   按了 ↓ 也看不见选中了哪条。
 * - 菜单挂在输入框上方（bottom-full），矮窗口时按往上还剩多少空间把高度压短，不顶出窗口外。
 *
 * @param active 当前选中项的下标，对应选项上的 data-i
 * @param open 菜单是否开着
 * @param maxRem 正常情况下的最大高度（rem），和容器上的 max-h-* 保持一致
 */
export function useMenuBox(active: number, open: boolean, maxRem: number) {
  const box = useRef<HTMLDivElement | null>(null)

  // 高度：底边由 bottom-full 的定位决定，跟自身高度无关，所以能算出往上还剩多少空间。
  // 放在滚动之前，先定好可视区高度，再决定滚多少
  useEffect(() => {
    const el = box.current
    if (!el || !open) return
    const fit = () => {
      // 字号设置会改根字号，max-h-80 这类 rem 值要按当前根字号换算成像素
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const bottom = el.getBoundingClientRect().bottom
      el.style.maxHeight = `${Math.max(120, Math.min(maxRem * root, bottom - 8, window.innerHeight * 0.6))}px`
    }
    fit()
    // 窗口大小变了、输入框长高了（多行）都要重算：观察菜单挂靠的输入框容器
    const host = el.offsetParent
    const ro = host instanceof Element ? new ResizeObserver(fit) : null
    if (host instanceof Element && ro) ro.observe(host)
    window.addEventListener('resize', fit)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [open, maxRem])

  // 滚动：只滚菜单自己，不用 scrollIntoView——它会把整个页面一起滚，菜单跟着输入框上下跳
  useEffect(() => {
    const el = box.current
    if (!el || !open) return
    const item = el.querySelector<HTMLElement>(`[data-i="${active}"]`)
    if (!item) return
    // 贴着上下边缘时留一点空隙，选中那一行不至于正好压在边上
    const pad = 4
    const top = item.offsetTop - pad
    const bottom = top + item.offsetHeight + pad * 2
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [active, open])

  return box
}
