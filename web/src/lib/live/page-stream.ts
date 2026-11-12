/**
 * 页面事件流 /api/app/events 的唯一一条连接（服务端 server/page-events.ts）：托盘信号、Agent 的界面操作、
 * 任务列表和 live 的推送都走它。浏览器对同一地址最多 6 条 HTTP/1.1 连接，对话页还各有一条实时推送，
 * 每个模块各开一条的话多开两三个标签页就会把连接占满，所以这里按引用计数共用一条。
 */
let es: EventSource | null = null
let users = 0
/** 服务端给这条连接的 id（hello 里带的）：断线重连后换新的，插件按它订阅推送 */
let conn = '' // 模块状态：运行时，跟着这条连接，重连时 hello 换新的
const connSubs = new Set<(conn: string) => void>() // 模块状态：运行时，订阅方自己撤

function attachHello(source: EventSource) {
  source.addEventListener('hello', (e) => {
    try {
      conn = String((JSON.parse((e as MessageEvent).data || '{}') as { conn?: string }).conn ?? '')
    } catch {
      conn = ''
    }
    if (conn) for (const fn of connSubs) fn(conn)
  })
}

/** 当前连接的 id；还没连上是空串 */
export const pageConn = () => conn

/**
 * 每次连上（含断线重连）回调一次，参数是新的连接 id；已经连着时马上回调一次。
 * 订阅了推送的（插件盯着打开的文件）在这里重新登记：重连前的订阅服务端已经随旧连接清掉了
 */
export function onPageConn(fn: (conn: string) => void) {
  connSubs.add(fn)
  if (conn) fn(conn)
  return () => {
    connSubs.delete(fn)
  }
}

/** 订阅页面事件流；close 撤掉这次加的监听，最后一个订阅撤掉时关闭连接 */
export function openPageStream() {
  if (!es) {
    es = new EventSource('/api/app/events')
    attachHello(es)
  }
  users++
  const source = es
  const offs: (() => void)[] = []
  return {
    on(event: string, fn: (e: MessageEvent) => void) {
      const h = (e: Event) => fn(e as MessageEvent)
      source.addEventListener(event, h)
      offs.push(() => source.removeEventListener(event, h))
    },
    close() {
      for (const off of offs.splice(0)) off()
      if (--users === 0) {
        source.close()
        if (es === source) {
          es = null
          conn = ''
        }
      }
    },
  }
}
