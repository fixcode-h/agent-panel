import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * 定时轮询的共用写法：上一次请求回来以后才排下一次（慢网时不叠请求），标签页在后台时不发，
 * 切回前台马上补一次。以前每个组件各写一遍 setInterval，有的不看标签页隐藏、有的会叠请求。
 */
export interface PollingOptions {
  run: () => unknown
  intervalMs: number
  /** 页面现在是不是在后台（测试里注入；默认看 document.hidden） */
  hidden?: () => boolean
  /** 订阅「切回前台」：返回取消订阅（测试里注入；默认监听 visibilitychange） */
  onVisible?: (cb: () => void) => () => void
}

export function startPolling({ run, intervalMs, hidden, onVisible }: PollingOptions) {
  const isHidden = hidden ?? (() => typeof document !== 'undefined' && document.hidden)
  let stopped = false
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }
  const tick = async () => {
    if (stopped || busy) return
    clearTimeout(timer)
    if (isHidden()) return schedule()
    busy = true
    try {
      await run()
    } catch {
      // 调用方自己决定要不要提示；这里只保证一次失败不让轮询停下
    } finally {
      busy = false
    }
    schedule()
  }
  const subscribe =
    onVisible ??
    ((cb: () => void) => {
      if (typeof document === 'undefined') return () => {}
      const h = () => !document.hidden && cb()
      document.addEventListener('visibilitychange', h)
      return () => document.removeEventListener('visibilitychange', h)
    })
  const unsubscribe = subscribe(() => void tick())
  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
  }
}

/**
 * React 里用 startPolling：intervalMs 为 null 时不轮询；key 变了（例如换了要查的范围）重新开始并立即查一次。
 * run 每次渲染可以是新函数，用的总是最新那个，不会因为它变了就重开定时器
 */
export function usePolling(run: () => unknown, intervalMs: number | null, key: unknown = '') {
  const ref = useRef(run)
  useLayoutEffect(() => {
    ref.current = run
  })
  useEffect(() => {
    if (intervalMs === null) return
    return startPolling({ run: () => ref.current(), intervalMs })
  }, [intervalMs, key])
}
