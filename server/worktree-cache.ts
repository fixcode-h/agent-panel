/**
 * 子对话分支状态的读缓存（合没合回、还有几个文件未提交）。
 *
 * 为什么要分两种读法：
 * - `/children` 是热点（父对话页每 4~15 秒刷一次，见 TaskView 的 CHILD_POLL_*），每个子对话要跑 3~4 条 git。
 *   几十个子对话时同步等 git 会把消息和 SSE 首包一起拖住（首屏白等几十秒），所以它用 `peek`：
 *   先给手上这份（可能过期），git 结果在后台补，下一次轮询就到位。
 * - 判定「子对话算不算做完」不能拿过期数据拍板，那条路径用 `read` 等这次的结果。
 *
 * 两条读法共用同一条缓存，所以：
 * - 同一个子对话同一时刻只有一条 git 在跑（按 id 去重，不看 key）：轮询再快、子对话改得再勤，
 *   也不会叠加成上百个 git 进程；过时那条的结果不会盖掉新的一轮（见 `latest`）；
 * - 后台补走单独一道闸：它再慢也只排在自己那条队里，不占 `read` 和 `/worktrees` 用的那道；
 * - git 读不出来时保留上一次的值，不把「没查到」写成「已经合回」（见 tasks.ts 的 childWorktree）。
 */

export type WorktreeRead<T> = {
  /** 查到（或上次查到）的状态；从没查到过是 null */
  value: T | null
  /**
   * true：有过一次和当前 key 对应的核对结果，**但可能已经过期**（TTL 内沿用缓存的那一条也是 true）。
   * false：还没核对过、或子对话已经变了新的一轮 —— 这时 value 是空的，不能当成「已经合回」
   */
  checked: boolean
}

type Load<T> = () => Promise<T | null>

export function createWorktreeCache<T>(opts: {
  /** 等结果的那条路（`read`）的并发上限：tasks.ts 的 gitGate，和 `/worktrees` 共用 */
  gate: <R>(run: () => Promise<R>) => Promise<R>
  /**
   * 后台补（`peek` 触发）的并发上限，单独一道闸。
   * 子对话几十个时后台要查上百条 git，和前台共用一道闸会让判定和 `/worktrees` 排队等它
   */
  background: <R>(run: () => Promise<R>) => Promise<R>
  now?: () => number
  /** 缓存留多少条；超出后丢掉最久没问过的（删掉的子对话不会一直留在这里） */
  keep?: number
}) {
  const now = opts.now ?? Date.now
  const keep = opts.keep ?? 200
  const seen = new Map<string, { key: string; at: number; value: T | null }>()
  const inflight = new Map<string, { key: string; run: Promise<T | null> }>()
  /** 每个子对话最近一次**起的**是哪一轮：过时那条 git 回来时据此丢掉结果 */
  const latest = new Map<string, string>()
  /** `read` 遇到别人在跑别的轮次时最多让几次：一直有人在起新轮次就这次不拍板，交给下一次 */
  const MAX_STALE_WAITS = 3

  /**
   * 起一次 git 查询。同一个子对话已经有在跑的就复用它，哪怕 key 已经变了——
   * 宁可拿旧一轮的结果让调用方判成「没核对过」，也不为同一个子对话并发几条 git。
   * 判定路径不能拿别的轮次的值，这一点由 `read` 自己等（见那里）。
   */
  function refresh(id: string, key: string, load: Load<T>, lane: (run: () => Promise<T | null>) => Promise<T | null>) {
    const running = inflight.get(id)
    if (running) return running.run
    // 只在真起一条新查询时记「最近问的是这一轮」：光是 peek 问一句不能把在跑那条的结果丢掉
    latest.set(id, key)
    const run = lane(load)
      .then((value) => {
        // 期间又换了新的一轮：这条结果对应的是旧 key，写进去会让下一次 peek 拿旧数据当新的
        if (latest.get(id) === key) {
          seen.set(id, { key, at: now(), value })
          // 删掉的子对话不会一直留在这里：超了就丢问得最早的那几条
          if (seen.size > keep)
            for (const [k] of [...seen].sort((a, b) => a[1].at - b[1].at).slice(0, seen.size - keep)) {
              seen.delete(k)
              latest.delete(k)
            }
        }
        return value
      })
      .catch(() => null)
      .finally(() => {
        if (inflight.get(id)?.run === run) inflight.delete(id)
      })
    inflight.set(id, { key, run })
    return run
  }

  return {
    /**
     * 界面用：立即返回，不排队等 git。过期的先给旧的，同时后台补一次。
     * key 变了（子对话又动了新的一轮）就不算核对过：上一轮的状态不能拿来显示这一轮。
     */
    peek(id: string, key: string, ttl: number, load: Load<T>): WorktreeRead<T> {
      const hit = seen.get(id)
      const usable = hit && hit.key === key ? hit : undefined
      const fresh = usable && now() - usable.at < ttl
      if (!fresh) void refresh(id, key, load, opts.background)
      return usable ? { value: usable.value, checked: true } : { value: null, checked: false }
    },
    /** 判定用：TTL 内沿用缓存，否则等这次的 git 结果；查不出来就是 null（拿不到结果时不可以拿过期数据拍板完成） */
    async read(id: string, key: string, ttl: number, load: Load<T>): Promise<WorktreeRead<T>> {
      const hit = seen.get(id)
      if (hit && hit.key === key && now() - hit.at < ttl) return { value: hit.value, checked: true }
      // 正在跑的是别的轮次：等它结束再看（同一时刻仍然只有一条 git）。
      // 不能直接复用它：那是一轮的值，拿给判定会把已经合回的子对话当成没合回。
      for (let i = 0; i < MAX_STALE_WAITS; i++) {
        const running = inflight.get(id)
        if (!running || running.key === key) break
        await running.run
      }
      // 等完仍然有别的轮次在跑（期间又有新的一轮进来）：这次不拍板，交给下一次
      const stale = inflight.get(id)
      if (stale && stale.key !== key) return { value: null, checked: false }
      return { value: await refresh(id, key, load, opts.gate), checked: true }
    },
  }
}
