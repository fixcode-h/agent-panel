/**
 * 同名并发控制的两个小工具：
 * - 执行位占位：检查「有没有人在执行」和占住它必须是同一步，否则两个请求在 await 的间隙里会各启动一遍
 * - 名额池：释放名额时直接把名额交给排队最久的那个，等待者不再自己增加计数，避免中间插进来的人超卖
 */

/** 同步占位：已经有执行时返回已有的那一份；没有才新建并占住 */
export function reserveOnce<K, V>(map: Map<K, V>, key: K, create: () => V) {
  const existing = map.get(key)
  if (existing !== undefined) return { value: existing, fresh: false as const }
  const value = create()
  map.set(key, value)
  return { value, fresh: true as const }
}

/** 只释放自己的执行位：旧的一轮收尾时不能把新的一轮删掉 */
export function releaseIfSame<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.get(key) === value) map.delete(key)
}

type Waiter = { resolve: () => void; reject: (e: Error) => void }

/**
 * 并发名额池。同一个键同时最多 limit 个，超出的按先后排队。
 * limit 每次取的时候重新算（对话设置里能改），但检查和占用在同一步完成。
 */
export function createSlotPool(limitFor: (key: string) => Promise<number> | number) {
  const groups = new Map<string, { running: number; queue: Waiter[] }>()
  function group(key: string) {
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { running: 0, queue: [] }))
    return g
  }
  function releaser(key: string, g: { running: number; queue: Waiter[] }) {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = g.queue.shift()
      // 名额直接交接，running 不变；等待者被唤醒后不再自增
      if (next) next.resolve()
      else {
        g.running--
        if (!g.running) groups.delete(key)
      }
    }
  }
  return {
    async take(key: string) {
      const limit = await limitFor(key)
      const g = group(key)
      // 前面已经有人排队时不插队，否则后到的请求会一直抢在等待者前面
      if (g.running >= limit || g.queue.length) {
        await new Promise<void>((resolve, reject) => g.queue.push({ resolve, reject }))
      } else g.running++
      return releaser(key, g)
    },
    /** 停止、删除这类不再开始排队的场景：排空队列，让等着的调用拿到明确失败，不会永远挂着 */
    drain(key: string, reason: Error) {
      const g = groups.get(key)
      if (!g) return
      for (const w of g.queue.splice(0)) w.reject(reason)
      if (!g.running) groups.delete(key)
    },
    queued: (key: string) => groups.get(key)?.queue.length ?? 0,
    running: (key: string) => groups.get(key)?.running ?? 0,
  }
}
