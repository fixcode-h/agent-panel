/**
 * 面板自带的浏览器扩展（extension/）的连接状态（从 shared/design.ts 拆出）：扩展是面板的，借网页版图片模型出图、抓页面；
 * UI 设计拆成插件后它留在面板这边。
 */

/** 浏览器扩展报上来的标签页 */
export interface BrowserTab {
  id: string
  site: 'gemini' | 'chatgpt'
  title: string
  url: string
}
/** 浏览器扩展的连接状态 */
export interface BrowserStatus {
  connected: boolean
  /** 浏览器里装的扩展版本 */
  version: string
  /** 面板自带的扩展版本 */
  latestVersion: string
  tabs: BrowserTab[]
  extensionDir: string
  /** 本机装了的浏览器，用来打开扩展页面 */
  browsers: { id: string; name: string }[]
}

/** 1.3 起的扩展能按面板的要求自己重新加载（浏览器不会自己重新加载已解压的扩展），更早的只能去扩展页面点刷新 */
export const extensionSelfReload = (version: string) => {
  const [major, minor] = version.split('.').map(Number)
  return major > 1 || (major === 1 && minor >= 3)
}
