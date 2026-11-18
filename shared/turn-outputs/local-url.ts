import { z } from 'zod'

/**
 * 「可浏览的地址」（设计稿第 4 节，项目共享目录 designs/Bug模式子对话体验-设计稿.md）：
 * Agent 交给面板的后台命令（npm run dev、vite、next dev、python -m http.server……）输出里出现本机地址时，
 * 面板认出来、探一下端口通了，放进「本轮产出」最上面一行，点了在右栏网页页签打开。
 *
 * 只按命令输出认，不看回复文字（ADR 0041、0049）；只认本机地址，不做反向代理、不对外网开放（ADR 0068）。
 * 正式后端（server/bg/url.ts）和演示后端都用这里的规则。
 */

/** 终端颜色码：Vite、Next 的启动横幅带颜色，不去掉的话端口号前后夹着控制字符 */
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/**
 * 本机地址：localhost、127.0.0.1、0.0.0.0、[::1]、[::]。0.0.0.0 和 [::] 是「监听所有网卡」，浏览器打不开，换成 localhost。
 * 192.168.x.x 这类局域网地址不认：Vite 同时打印 Local 和 Network 两行，只要 Local 那一行
 */
const LOCAL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>()[\]{}`]*)?/i

/** 一行输出里的本机地址（统一成 http://localhost:端口/路径）；没有就是空串 */
export function findLocalUrl(line: string): string {
  const m = LOCAL.exec(line.replace(ANSI, ''))
  if (!m) return ''
  // 句末的标点不是地址的一部分（「已启动：http://localhost:3000.」）
  const raw = m[0].replace(/[.,;:!?。，；]+$/, '')
  const at = /^(https?):\/\/([^/:]+|\[[^\]]*\])(?::(\d+))?(\/.*)?$/i.exec(raw)
  if (!at) return ''
  // 监听所有网卡的写法浏览器打不开，换成 localhost
  const host = /^(0\.0\.0\.0|\[::1?\])$/.test(at[2]) ? 'localhost' : at[2].toLowerCase()
  return `${at[1].toLowerCase()}://${host}${at[3] ? `:${Number(at[3])}` : ''}${at[4] ?? '/'}`
}

/** 地址里的主机和端口（探活用）：没写端口按协议的默认端口 */
export function urlPort(url: string): { host: string; port: number } | null {
  const at = /^(https?):\/\/([^/:]+|\[[^\]]*\])(?::(\d+))?/i.exec(url)
  if (!at) return null
  const port = at[3] ? Number(at[3]) : at[1].toLowerCase() === 'https' ? 443 : 80
  const host = at[2] === 'localhost' ? '127.0.0.1' : at[2].replace(/^\[|\]$/g, '')
  return port > 0 && port < 65536 ? { host, port } : null
}

/** 页面上显示的地址：去掉协议和结尾的斜杠（localhost:5173） */
export const urlLabel = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** 运行时状态里的一个可浏览地址（shared/live/task-live.ts 的 urls）：哪条后台命令起的、还在不在跑 */
export const LiveUrl = z.object({
  /** 后台命令编号：停止、重新运行都按它 */
  job: z.string(),
  url: z.string(),
  name: z.string(),
  command: z.string(),
  state: z.enum(['running', 'stopped']),
  startedAt: z.string(),
})
export type LiveUrl = z.infer<typeof LiveUrl>

/**
 * 本轮产出里列哪些地址：还在跑的都列（上一轮起的开发服务器还开着，用户照样要看），
 * 停了的只列这一轮起的（since 是用户最后一次发话的时间）；新起的在前
 */
export function roundUrls(urls: LiveUrl[], since: string) {
  const at = Date.parse(since)
  return urls
    .filter((u) => u.state === 'running' || !since || Date.parse(u.startedAt) >= at)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
}
