/**
 * iframe 里面板自己发的页面（插件网页页面、本机 HTML、设置里的示例 HTML）也用全站那套滚动条：
 * iframe 是另一个文档，面板 index.css 的 ::-webkit-scrollbar 管不到，不处理就是浏览器原生的
 * （Windows 上带上下箭头、带竖分隔线）。服务端发沙箱 HTML、网页框塞 srcdoc 时在 <head> 最前面插一段样式，
 * 页面自己写了滚动条样式的照样以页面的为准（同优先级，后写的生效）。
 */

/** 滚动条的几个值：srcdoc 由面板按当前设置算好传进来；服务端不知道主题，用深浅底上都看得清的半透明灰 */
export interface ScrollbarLook {
  size: string
  pad: string
  thumb: string
  hover: string
}

/** 和设置 → 组件 →「滚动条」的默认值同宽同留白 */
export const NEUTRAL_SCROLLBAR: ScrollbarLook = {
  size: '10px',
  pad: '2px',
  thumb: 'rgba(128,128,128,.4)',
  hover: 'rgba(128,128,128,.65)',
}

/** 值里只允许颜色、长度会用到的字符：防止设置里坏掉的值把 <style> 提前闭合 */
const safe = (v: string) => v.replace(/[^\w#%.,()\s/-]/g, '')

export function scrollbarCss(l: ScrollbarLook = NEUTRAL_SCROLLBAR) {
  const [size, pad, thumb, hover] = [l.size, l.pad, l.thumb, l.hover].map(safe)
  return (
    `::-webkit-scrollbar{width:${size};height:${size};background:transparent}` +
    `::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}` +
    `::-webkit-scrollbar-button{display:none;width:0;height:0}` +
    `::-webkit-scrollbar-thumb{background-color:${thumb};border-radius:999px;border:${pad} solid transparent;background-clip:padding-box}` +
    `::-webkit-scrollbar-thumb:hover,::-webkit-scrollbar-thumb:active{background-color:${hover}}` +
    // Firefox 没有 webkit 伪元素，用标准属性；Chromium 上不写，写了它就不认上面那套
    `@supports not selector(::-webkit-scrollbar){html{scrollbar-width:thin;scrollbar-color:${thumb} transparent}}`
  )
}

/**
 * 在 HTML 里插入滚动条样式：有 <head> 插在它后面，没有就插在 <html> 或 doctype 后面
 * （插到 doctype 前面会让页面进怪异模式）。已经插过的不重复插
 */
export function withPanelScrollbar(html: string, look?: ScrollbarLook) {
  if (html.includes('data-panel-scrollbar')) return html
  const tag = `<style data-panel-scrollbar>${scrollbarCss(look)}</style>`
  const at = /<head(?:\s[^>]*)?>/i.exec(html) ?? /<html(?:\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html)
  if (!at) return tag + html
  const end = at.index + at[0].length
  return html.slice(0, end) + tag + html.slice(end)
}
