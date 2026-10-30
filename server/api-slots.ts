/**
 * API 并发上限：按 API 数同时在请求模型的 CLI 调用（对话这一轮、子任务、工作流节点、子对话），
 * 满了的按到达顺序排队，前面的释放了再开始。上限是 API 设置里的 maxConcurrent，0 不限制。
 *
 * 只算真正在用模型的那段时间：对话停在等下一句、等子任务、等别的 Agent 回答时让出名额（见 runner 的 waitNext
 * 和引擎的 yieldSlot）。占着名额等子任务的话，父对话等子任务、子任务又排队等父对话的名额，就互相等死了。
 */

/** API id → 上限；设置读进来、保存时更新（见 server/settings.ts） */
const limits = new Map<string, number>()
/** API id → 占着的名额 */
const used = new Map<string, number>()
/** 排着的一个：enter 放它进去，moved 告诉它前面还有几个 */
interface Queued {
  enter: () => void
  moved?: (ahead: number) => void
}
/** API id → 排着的（先到先得） */
const queues = new Map<string, Queued[]>()

/** 队伍动了：每个排着的都更新一下前面还有几个（界面上显示） */
const moved = (q: Queued[]) => q.forEach((x, i) => x.moved?.(i))

const free = (key: string) => {
  const max = limits.get(key) ?? 0
  return max <= 0 || (used.get(key) ?? 0) < max
}

/** 有空位就按顺序放排着的进去：释放时、上限调大时都要走一遍 */
function pump(key: string) {
  const q = queues.get(key)
  let n = 0
  while (q?.length && free(key)) {
    used.set(key, (used.get(key) ?? 0) + 1)
    q.shift()!.enter()
    n++
  }
  if (q && !q.length) queues.delete(key)
  else if (q && n) moved(q)
}

/** 设置里的上限变了：调大或改成不限制时，排着的马上放进去 */
export function setApiLimits(apis: { id: string; maxConcurrent?: number }[]) {
  limits.clear()
  for (const a of apis) if (a.maxConcurrent) limits.set(a.id, a.maxConcurrent)
  for (const key of [...queues.keys()]) pump(key)
}

/**
 * 占一个名额。没空位时排队，onQueue 拿到前面还有几个（队伍动了会再调）；停止信号到了从队里拿掉、返回 false。
 * 名额由释放方直接交接给排在最前面的，不会被后来的插队
 */
export function acquireApi(key: string, signal: AbortSignal, onQueue?: (ahead: number) => void): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (free(key) && !queues.get(key)?.length) {
    used.set(key, (used.get(key) ?? 0) + 1)
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const q = queues.get(key) ?? queues.set(key, []).get(key)!
    const me: Queued = {
      enter: () => {
        signal.removeEventListener('abort', leave)
        resolve(true)
      },
      moved: onQueue,
    }
    const leave = () => {
      const i = q.indexOf(me)
      if (i >= 0) q.splice(i, 1)
      if (!q.length) queues.delete(key)
      else moved(q)
      resolve(false)
    }
    q.push(me)
    signal.addEventListener('abort', leave, { once: true })
    onQueue?.(q.length - 1)
  })
}

export function releaseApi(key: string) {
  const n = used.get(key) ?? 0
  if (n <= 1) used.delete(key)
  else used.set(key, n - 1)
  pump(key)
}

/** 现在占着几个、排着几个（界面和测试看） */
export const apiUsage = (key: string) => ({ used: used.get(key) ?? 0, queued: queues.get(key)?.length ?? 0 })

/**
 * 一次 CLI 调用手里的名额：让出（等下一句、等子任务）和拿回（接着干）都走它，重复调用不会多占或多还
 */
export class ApiSlot {
  private held = false
  /** key 是 API id，name 是界面上显示的 API 名称 */
  constructor(
    readonly key: string,
    readonly name: string,
  ) {}
  get holding() {
    return this.held
  }
  private pending?: Promise<boolean>
  /** 排队中的这次拿名额：放弃时用它把排队撤掉，否则名额会放行给一个已经不要的 slot，永远不还 */
  private waiting?: AbortController
  /** 拿名额的代数：drop 放弃了上一代排队后，新一代的 finally 不能被上一代误清 */
  private gen = 0
  take(signal: AbortSignal, onQueue?: (ahead: number) => void): Promise<boolean> {
    if (this.held) return Promise.resolve(true)
    // 同一次调用两处同时要拿回（等下一句和工具里的等待）：共用一次排队，不多占
    this.pending ??= this.acquire(signal, onQueue)
    return this.pending
  }
  private async acquire(signal: AbortSignal, onQueue?: (ahead: number) => void): Promise<boolean> {
    const gen = ++this.gen
    // 外部停止和「自己放弃排队」合成一个信号：acquireApi 收到它就离开队伍
    const give = new AbortController()
    const onAbort = () => give.abort(signal.reason)
    if (signal.aborted) give.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
    this.waiting = give
    let ok = false
    try {
      ok = await acquireApi(this.key, give.signal, onQueue)
    } finally {
      signal.removeEventListener('abort', onAbort)
      // waiting 和 pending 都要比代数：drop 后马上重新排队时，上一代的终于清理跑得比新一代晚，
      // 无条件写回会把新一代的撤销句柄清掉，下一次 drop 就撤销不了排队（名额照样漏）
      if (this.gen === gen) {
        this.waiting = undefined
        this.pending = undefined
      }
    }
    if (!ok) return false
    // 刚被放行（名额已经算到这一次名下）就放弃了：立刻还回去，不然这个名额再也没人还
    if (give.signal.aborted) {
      releaseApi(this.key)
      return false
    }
    this.held = true
    return true
  }
  /** 让出名额；排队中则撤销排队，两种情况都不会多占或泄漏 */
  drop() {
    if (this.waiting) {
      this.waiting.abort()
      // 这次排队已经放弃：新的 take 不在这条注定失败的排队上复用
      this.gen++
      this.pending = undefined
    }
    if (!this.held) return
    this.held = false
    releaseApi(this.key)
  }
}
