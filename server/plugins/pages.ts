import { onPageClose, pageOpen, signalPages } from '../page-events.ts'
import type { PluginPages } from './sdk.ts'

/**
 * 插件的推送通道（插件接口 7，PluginServerContext.pages）：插件服务端发的事件走页面事件流 /api/app/events
 * （server/page-events.ts），网页那头 web/src/plugins/events.ts 按插件 id 分给订阅的组件。
 * 插件 id 由这里填，插件只能推给自己的网页部分；插件关掉时它登记的断开回调一起撤掉（dispose）。
 */
export function pluginPages(plugin: string): { api: PluginPages; dispose: () => void } {
  const offs = new Set<() => void>()
  let live = true
  return {
    api: {
      push: (event, data, to) => {
        if (!live) return 0
        const list = to === undefined ? undefined : typeof to === 'string' ? [to] : to
        return signalPages({ type: 'plugin', plugin, event: String(event), data }, list)
      },
      open: (conn) => pageOpen(conn),
      onClose: (fn) => {
        if (!live) return () => {}
        const off = onPageClose(fn)
        offs.add(off)
        return () => {
          off()
          offs.delete(off)
        }
      },
    },
    dispose: () => {
      live = false
      for (const off of offs) off()
      offs.clear()
    },
  }
}
