import { useEffect, useRef } from 'react'
import { onPageConn, openPageStream, pageConn } from '@/lib/live/page-stream'

/**
 * 插件的推送通道（插件接口 7）网页这一头：服务端插件用 ctx.pages.push 发的事件经页面事件流 /api/app/events
 * （server/page-events.ts，一个页面只开一条连接）到这里，再按「插件 id + 事件名」分给订阅的组件。
 * 插件要实时数据（外面改了打开着的文件）就用它，不在插件里定时拉接口。
 * 在线演示没有服务端，订阅什么都收不到。
 */

type Listener = (data: unknown) => void
const listeners = new Map<string, Set<Listener>>() // 模块状态：运行时，订阅方自己撤；空了就关掉事件流
let stream: ReturnType<typeof openPageStream> | null = null // 模块状态：运行时，第一个订阅时开、最后一个撤掉时关
let holds = 0 // 模块状态：运行时，订阅和连接回调的个数，归零时关掉事件流

const keyOf = (plugin: string, event: string) => `${plugin}\u0000${event}`

/** 有人要用事件流：第一个时打开；返回的函数撤掉这一份，最后一份撤掉时关掉 */
function hold() {
  holds++
  ensureStream()
  let done = false
  return () => {
    if (done) return
    done = true
    if (--holds > 0 || !stream) return
    stream.close()
    stream = null
  }
}

function ensureStream() {
  if (stream || import.meta.env.VITE_DEMO) return
  stream = openPageStream()
  stream.on('plugin', (e) => {
    let s: { plugin?: string; event?: string; data?: unknown }
    try {
      s = JSON.parse(e.data) as typeof s
    } catch {
      return
    }
    const set = listeners.get(keyOf(String(s.plugin), String(s.event)))
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(s.data)
      } catch (err) {
        // 一个订阅方出错不影响别的，也不能让事件流的处理断掉
        console.error(err)
      }
    }
  })
}

/** 订阅某个插件的一种推送；返回撤掉订阅的函数 */
export function onPluginEvent(plugin: string, event: string, fn: Listener) {
  const key = keyOf(plugin, event)
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(fn)
  const release = hold()
  return () => {
    set.delete(fn)
    if (!set.size) listeners.delete(key)
    release()
  }
}

/** 交给插件的推送接口（host.events），按插件 id 绑好 */
export function pluginEvents(plugin: string) {
  return {
    /** 订阅推送；返回撤掉订阅的函数 */
    on: (event: string, fn: Listener) => onPluginEvent(plugin, event, fn),
    /** 组件里订阅推送：卸载时自动撤掉，fn 换了不重新订阅 */
    useEvent: (event: string, fn: Listener) => usePluginEvent(plugin, event, fn),
    /** 这个页面的连接 id，服务端 ctx.pages.push 的 to 填它；还没连上是空串 */
    conn: pageConn,
    /**
     * 每次连上（含断线重连）回调一次新的连接 id，已经连着时马上回调一次。
     * 向服务端登记订阅（例如要盯哪个文件）放在这里：重连前的登记已随旧连接清掉了
     */
    onConnect: (fn: (conn: string) => void) => {
      const release = hold()
      const off = onPageConn(fn)
      return () => {
        off()
        release()
      }
    },
  }
}

function usePluginEvent(plugin: string, event: string, fn: Listener) {
  const cb = useRef(fn)
  cb.current = fn
  useEffect(() => onPluginEvent(plugin, event, (d) => cb.current(d)), [plugin, event])
}
