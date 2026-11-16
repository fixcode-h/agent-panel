/**
 * 页面打开时取全局数据（Agent、工作流、项目、设置……）。
 *
 * 以前是 Promise.all 一把取：服务刚启动（升级后重启、插件还在初始化）时任何一份慢了、失败了，
 * 整批都作废，项目列表一直是空的，侧栏和首页就显示「添加第一个项目」，用户点进去是一个
 * 「新建项目」弹窗（没有目录，AI 初始化点不了、也保存不了），看起来像旧项目被卡住了。
 * 现在每份各取各的，取到就先用；失败的报一次错，隔一会儿只重取失败的那几份，直到都取到才算加载完。
 */
export type InitialPart = {
  /** 报错时显示的名字（只用于日志和提示，不翻译） */
  name: string
  load: () => Promise<unknown>
  apply: (value: unknown) => void
}

/** 把「取」和「放」配成一项，调用方不用自己写类型断言 */
export function part<T>(name: string, load: () => Promise<T>, apply: (v: T) => void): InitialPart {
  return { name, load, apply: (v) => apply(v as T) }
}

/** 重试间隔：1、2、4、8 秒，之后每 10 秒一次（服务一直连不上时也不会刷屏） */
export const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 10_000)

/**
 * 取全部；都取到后调 onDone。第一次有失败时调 onError（只报一次，之后静默重试）。
 * 返回取消函数：组件卸载后不再重试、也不再写状态。
 */
export function loadInitialData(
  parts: InitialPart[],
  onDone: () => void,
  onError: (message: string) => void,
  wait: (ms: number, fn: () => void) => () => void = (ms, fn) => {
    const h = setTimeout(fn, ms)
    return () => clearTimeout(h)
  },
): () => void {
  let cancelled = false
  let reported = false
  let cancelTimer: (() => void) | undefined
  const round = async (pending: InitialPart[], attempt: number) => {
    const results = await Promise.allSettled(pending.map((p) => p.load()))
    if (cancelled) return
    const failed: InitialPart[] = []
    let firstError = ''
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') pending[i].apply(r.value)
      else {
        failed.push(pending[i])
        firstError ||= (r.reason as Error)?.message ?? String(r.reason)
      }
    })
    if (!failed.length) return onDone()
    if (!reported) {
      reported = true
      onError(firstError)
    }
    cancelTimer = wait(retryDelay(attempt), () => void round(failed, attempt + 1))
  }
  void round(parts, 0)
  return () => {
    cancelled = true
    cancelTimer?.()
  }
}
