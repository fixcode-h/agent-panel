/**
 * 页面事件流 /api/app/events 的唯一一条连接（服务端 server/page-events.ts）：托盘信号、Agent 的界面操作、
 * 任务列表和 live 的推送都走它。浏览器对同一地址最多 6 条 HTTP/1.1 连接，对话页还各有一条实时推送，
 * 每个模块各开一条的话多开两三个标签页就会把连接占满，所以这里按引用计数共用一条。
 */
let es: EventSource | null = null
let users = 0

/** 订阅页面事件流；close 撤掉这次加的监听，最后一个订阅撤掉时关闭连接 */
export function openPageStream() {
  es ??= new EventSource('/api/app/events')
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
        if (es === source) es = null
      }
    },
  }
}
