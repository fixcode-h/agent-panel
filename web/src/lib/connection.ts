import { useSyncExternalStore } from 'react'

/**
 * 和面板服务的连接状态：任何一次请求连不上（fetch 抛 TypeError）就记成断开，任何一次拿到响应就记成连上。
 * 以前连不上时各处只是保留旧数据、吞掉错误，用户看到的是一个「看起来正常但什么都不动」的页面
 */
let offline = false
const subs = new Set<() => void>()

function set(v: boolean) {
  if (offline === v) return
  offline = v
  for (const f of subs) f()
}

export const markOnline = () => set(false)
export const markOffline = () => set(true)
export const isOffline = () => offline

/** fetch 的包装：只负责记连接状态，响应和错误原样交回调用方 */
export async function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(input, init)
    markOnline()
    return res
  } catch (e) {
    // 主动取消的不算断开
    if ((e as Error).name !== 'AbortError') markOffline()
    throw e
  }
}

export function useOffline() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => offline,
  )
}
