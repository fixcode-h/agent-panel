import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import type { McpToolTitles } from '../shared/mcp-catalog/tool-titles.ts'

/**
 * 托盘要页面做的事：点图标时把已经打开的面板切到前台（focus），右键「设置」时顺便打开设置（view）。
 * 浏览器不让外面的程序切换标签页，所以由页面把标题临时加上 mark，托盘按标题找到这个标签页再切过去。
 */
export type PageSignal =
  | { type: 'focus'; mark: string; view?: 'settings' }
  /** Agent 经动作表（server/app-actions）要页面做的界面操作，页面在 web/src/lib/ui-actions.ts 里找处理函数 */
  | { type: 'ui'; action: string; args: Record<string, unknown> }
  /** 插件服务端推给自己网页部分的事件（插件接口 7，PluginServerContext.pages），页面在 web/src/plugins/events.ts 分给订阅的插件 */
  | { type: 'plugin'; plugin: string; event: string; data: unknown }
  /** 别家 MCP 服务的工具显示名有变化（server/mcp-catalog/external-titles.ts），整份推给页面 */
  | { type: 'mcp-titles'; titles: McpToolTitles }

/** 每条连接一个 id（连上时随 hello 发给页面）：插件按它只推给订阅了的页面，连接断了按它清掉订阅 */
const pages = new Map<string, (s: PageSignal) => void>() // 模块状态：会话，跟着进程或连接一起没
const closers = new Set<(conn: string) => void>() // 模块状态：会话，订阅方自己撤

/**
 * 同一条页面事件流上的其他推送源（任务列表和顶层对话的 live，见 server/tasks/page-feed.ts）。
 * 一个页面只开这一条 SSE：浏览器对同一地址最多 6 条 HTTP/1.1 连接，对话页还各有一条实时推送，
 * 每多一条常驻连接，多开两三个标签页就会把连接占满、普通请求排队卡住。
 * 页面连上时依次调用每个推送源，返回值在断开时调用（停掉它的定时器等）。
 */
export type PageFeed = (send: (event: string, data: unknown) => Promise<void>) => Promise<() => void>
const feeds: PageFeed[] = []
export function addPageFeed(feed: PageFeed) {
  feeds.push(feed)
}

/**
 * 发给打开着的面板页面，返回发给了几个页面；没有页面时托盘直接打开新的。
 * to 给了就只发给这几条连接（插件推给订阅了某个文件的页面），不在的连接跳过
 */
export function signalPages(s: PageSignal, to?: Iterable<string>) {
  if (!to) {
    for (const p of pages.values()) p(s)
    return pages.size
  }
  let n = 0
  for (const id of new Set(to)) {
    const p = pages.get(id)
    if (!p) continue
    p(s)
    n++
  }
  return n
}

/** 这条连接还在不在 */
export const pageOpen = (conn: string) => pages.has(conn)

/** 连接断开时回调（插件清掉这个页面的订阅）；返回撤掉回调的函数 */
export function onPageClose(fn: (conn: string) => void) {
  closers.add(fn)
  return () => {
    closers.delete(fn)
  }
}

/** 每个面板页面连一条（SSE），托盘有事时推过去 */
export const pageEventsApi = () =>
  new Hono().get('/events', (c) => {
    // 经过 cloudflared / nginx 时不要缓冲，事件要马上到页面
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      const queue: PageSignal[] = []
      let wake: (() => void) | undefined
      const push = (s: PageSignal) => {
        queue.push(s)
        wake?.()
      }
      let closed = false
      let detach: (() => void)[] = []
      const conn = randomUUID()
      const stop = () => {
        for (const d of detach.splice(0)) d()
        if (!pages.delete(conn)) return
        // 只在第一次删掉时通知：onAbort 和循环结束都会走到这里
        for (const fn of closers) {
          try {
            fn(conn)
          } catch {
            // 一个订阅方出错不影响别的
          }
        }
      }
      pages.set(conn, push)
      stream.onAbort(() => {
        closed = true
        stop()
        wake?.()
      })
      // 连接 id 随 hello 发给页面：EventSource 断线重连会拿到新 id，页面据此重新订阅
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ conn }) })
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) })
      detach = await Promise.all(feeds.map((f) => f(send)))
      // 推送源接上之前页面就关了：onAbort 已经跑过，这里补上收尾
      if (closed) stop()
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
      stop()
    })
  })

/** 解析托盘写进服务输入的一行命令：「focus <mark> [settings]」「update」 */
export function parseTrayCommand(line: string) {
  const [cmd, ...args] = line.trim().split(/\s+/)
  if (cmd === 'focus' && /^[\w-]{1,40}$/.test(args[0] ?? ''))
    return { cmd: 'focus' as const, mark: args[0], view: args[1] === 'settings' ? ('settings' as const) : undefined }
  if (cmd === 'update') return { cmd: 'update' as const }
  return undefined
}
