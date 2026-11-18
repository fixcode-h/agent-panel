import { NEUTRAL_SCROLLBAR, type ScrollbarLook } from '@shared/web-view/scrollbar'

/**
 * 面板当前的滚动条样子（设置 → 组件 →「滚动条」+ 当前配色、深浅色），给 srcdoc 页面用：
 * 自定义属性的计算值已经把 var() 换成了实际值，iframe 里直接能用。取不到（没挂上样式）就用中性灰
 */
export function panelScrollbarLook(): ScrollbarLook {
  const cs = getComputedStyle(document.documentElement)
  const get = (k: string, fallback: string) => cs.getPropertyValue(k).trim() || fallback
  return {
    size: get('--c-scrollbar-size', NEUTRAL_SCROLLBAR.size),
    pad: get('--c-scrollbar-pad', NEUTRAL_SCROLLBAR.pad),
    thumb: get('--c-scrollbar-thumb', NEUTRAL_SCROLLBAR.thumb),
    hover: get('--c-scrollbar-hover', NEUTRAL_SCROLLBAR.hover),
  }
}
