import { useEffect, useRef } from 'react'
import { runUiAction } from './ui-actions'

/**
 * 托盘（Windows 的 AgentPanel.exe）点图标时切到已经打开的面板，而不是每次开一个新标签页。
 * 浏览器不让外面的程序直接切换标签页：服务把托盘的请求推给每个打开着的页面（server/page-events.ts），
 * 页面把标题临时加上托盘给的 mark，托盘按标题找到这个标签页再切过去。切过来后标题恢复。
 */

let base = typeof document === 'undefined' ? '' : document.title
let mark = ''
const apply = () => {
  document.title = mark ? `${base} · ${mark}` : base
}

/** 页面平时的标题（执行中的任务数等）；托盘找标签页的标记会接在后面 */
export function setBaseTitle(title: string) {
  base = title
  apply()
}

/** 托盘找不到已经打开的页面时，打开新页面的地址带上 open=settings */
function takeOpenParam() {
  const url = new URL(location.href)
  const v = url.searchParams.get('open')
  if (!v) return ''
  url.searchParams.delete('open')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  return v
}

/** 接收托盘的请求：切到前台后再做（打开设置），免得藏在后面的标签页也弹出设置 */
export function usePageSignals(onView: (view: string) => void) {
  const cb = useRef(onView)
  cb.current = onView
  useEffect(() => {
    const first = takeOpenParam()
    if (first) cb.current(first)
    if (import.meta.env.VITE_DEMO) return
    let pending: { view?: string; until: number } | undefined
    let clear: ReturnType<typeof setTimeout> | undefined
    const arrived = () => {
      if (!pending || document.visibilityState !== 'visible' || !document.hasFocus()) return
      const p = pending
      pending = undefined
      mark = ''
      apply()
      if (p.view && Date.now() < p.until) cb.current(p.view)
    }
    const es = new EventSource('/api/app/events')
    es.addEventListener('focus', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as { mark: string; view?: string }
      pending = { view: s.view, until: Date.now() + 8000 }
      mark = s.mark
      apply()
      // 托盘没能切过来（例如在别的浏览器里）就算了，标题过一会儿恢复
      clearTimeout(clear)
      clear = setTimeout(() => {
        pending = undefined
        mark = ''
        apply()
      }, 8000)
      window.focus()
    })
    // 对话里的 Agent 要页面做的界面操作（见 ui-actions.ts）：不等切到前台，用户可能正看着对话
    es.addEventListener('ui', (e) => {
      try {
        const s = JSON.parse((e as MessageEvent).data) as { action: string; args: Record<string, unknown> }
        runUiAction(s.action, s.args)
      } catch {}
    })
    window.addEventListener('focus', arrived)
    document.addEventListener('visibilitychange', arrived)
    return () => {
      es.close()
      clearTimeout(clear)
      window.removeEventListener('focus', arrived)
      document.removeEventListener('visibilitychange', arrived)
    }
  }, [])
}
