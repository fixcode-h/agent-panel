import net from 'node:net'
import { findLocalUrl, urlPort, type LiveUrl } from '../../shared/turn-outputs/local-url.ts'

/**
 * 后台命令输出里的本机地址（规则见 shared/turn-outputs/local-url.ts）：认出来以后探一下端口，通了才记到命令上，
 * 运行时状态（server/tasks/live.ts）据此给页面「可浏览的地址」。只记在内存里的命令记录上，不落盘：
 * 面板重启后命令本身也不在了
 */

/** 命令记录上和地址有关的几项（server/background.ts 的 BgJob） */
export interface UrlJob {
  id: string
  name: string
  command: string
  state: string
  startedAt: string
  endedAt: string
  /** 探活通过的地址 */
  url?: string
  /** 认出来、正在探的地址：探的期间同一个地址不再重复探 */
  urlProbing?: string
}

/** 连一下这个端口：连得上就算服务起来了。只连本机，不发任何请求 */
export function portOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * 开发服务器常常先打印地址、过一会儿才真正监听（Next 编译完才开端口）：隔一会儿再探，最多探 tries 次
 */
async function waitOpen(url: string, probe: typeof portOpen, tries: number, gapMs: number) {
  const at = urlPort(url)
  if (!at) return false
  for (let i = 0; i < tries; i++) {
    if (await probe(at.host, at.port)) return true
    await new Promise((r) => setTimeout(r, gapMs))
  }
  return false
}

/**
 * 每行输出过一遍：还没认出地址时找本机地址，找到就去探；探通了记下，探不通放掉，等后面的输出再认。
 * 一条命令只记第一个探通的地址（Vite 会打印 Local 和 Network 两行，前者就是要的）
 */
export function sniffUrl(
  j: UrlJob,
  line: string,
  opts: { probe?: typeof portOpen; tries?: number; gapMs?: number } = {},
) {
  if (j.url || j.urlProbing || j.endedAt) return
  const url = findLocalUrl(line)
  if (!url) return
  j.urlProbing = url
  return waitOpen(url, opts.probe ?? portOpen, opts.tries ?? 20, opts.gapMs ?? 500).then((ok) => {
    j.urlProbing = undefined
    if (ok && !j.endedAt) j.url = url
  })
}

/** 交给页面的地址：认出过地址的命令，跑着的算运行中，结束了（停止、失败、成功退出）都算已停止 */
export function liveUrls(list: UrlJob[]): LiveUrl[] {
  return list
    .filter((j) => j.url)
    .map((j) => ({
      job: j.id,
      url: j.url!,
      name: j.name,
      command: j.command,
      state: j.state === 'running' ? 'running' : 'stopped',
      startedAt: j.startedAt,
    }))
}
