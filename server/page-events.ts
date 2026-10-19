import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

/**
 * 托盘要页面做的事：点图标时把已经打开的面板切到前台（focus），右键「设置」时顺便打开设置（view）。
 * 浏览器不让外面的程序切换标签页，所以由页面把标题临时加上 mark，托盘按标题找到这个标签页再切过去。
 */
export type PageSignal = { type: 'focus'; mark: string; view?: 'settings' }

const pages = new Set<(s: PageSignal) => void>()

/** 发给所有打开着的面板页面，返回有几个页面在听；没有页面时托盘直接打开新的 */
export function signalPages(s: PageSignal) {
  for (const p of pages) p(s)
  return pages.size
}

/** 每个面板页面连一条（SSE），托盘有事时推过去 */
export const pageEventsApi = () =>
  new Hono().get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: PageSignal[] = []
      let wake: (() => void) | undefined
      const push = (s: PageSignal) => {
        queue.push(s)
        wake?.()
      }
      let closed = false
      pages.add(push)
      stream.onAbort(() => {
        closed = true
        pages.delete(push)
        wake?.()
      })
      await stream.writeSSE({ event: 'hello', data: '' })
      while (!closed) {
        if (!queue.length) {
          // 没事时 15 秒发一次心跳，免得连接被当成空闲断掉
          await new Promise<void>((r) => {
            const timer = setTimeout(r, 15_000)
            wake = () => {
              clearTimeout(timer)
              r()
            }
          })
          wake = undefined
        }
        if (closed) break
        if (queue.length)
          for (const s of queue.splice(0)) await stream.writeSSE({ event: s.type, data: JSON.stringify(s) })
        else await stream.writeSSE({ event: 'ping', data: '' })
      }
      pages.delete(push)
    }),
  )

/** 解析托盘写进服务输入的一行命令：「focus <mark> [settings]」「update」 */
export function parseTrayCommand(line: string) {
  const [cmd, ...args] = line.trim().split(/\s+/)
  if (cmd === 'focus' && /^[\w-]{1,40}$/.test(args[0] ?? ''))
    return { cmd: 'focus' as const, mark: args[0], view: args[1] === 'settings' ? ('settings' as const) : undefined }
  if (cmd === 'update') return { cmd: 'update' as const }
  return undefined
}
