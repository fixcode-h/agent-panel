/**
 * 对话页面是否还开着：CLI 在 MCP 工具上等用户下一句时，只有页面还开着才继续等。
 * 切走（页面卸载或隐藏）后给一段宽限，期间切回来还能直接接着说；过了宽限让 CLI 结束这一轮。
 * 宽限时长在设置里改（presenceGraceMinutes / unreadGraceMinutes），环境变量优先，测试用。
 * 两个时长只管「回复完停在等下一句」的空闲会话：这一轮还在跑（CLI 正在处理、在等子任务）的对话
 * 到点也不回收，由调用方通过 setPresenceBusy 提供判定（见 server/tasks.ts 的 keepAliveBusy）。
 * 保活会话的数量上限（keepAliveLimit）也不在这里：那个要看哪些任务还在跑、名下有没有子对话，
 * 由 server/tasks.ts 的 enforceKeepAlive 统一收，这里只负责「到时间了该放手」
 */
const fixedMs = (name: string) => {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, n) : undefined
}
const FIXED_GRACE_MS = fixedMs('AGENT_PANEL_PRESENCE_GRACE_MS')
const FIXED_UNREAD_GRACE_MS = fixedMs('AGENT_PANEL_PRESENCE_UNREAD_GRACE_MS')

/** 看过之后离开的宽限：回来接着说不用重开 CLI */
const DEFAULT_GRACE_MS = 60 * 60_000
/** 这一轮完成但没打开看过的宽限：橙点还亮着，用户可能隔一会儿回来，给短一点的一段 */
const DEFAULT_UNREAD_GRACE_MS = 30 * 60_000

let graceMs = DEFAULT_GRACE_MS
let unreadGraceMs = DEFAULT_UNREAD_GRACE_MS
let reclaimEnabled = true

const nonNegative = (v: number, fallback: number) => (Number.isFinite(v) ? Math.max(0, v) : fallback)

/**
 * 改宽限期（设置保存后调用）；0 表示页面切走就让 CLI 结束这一轮。
 * 只改「看过之后离开」这一段，未读宽限和总开关看 setPresenceReclaimPolicy
 */
export function setPresenceGraceMs(ms: number) {
  graceMs = nonNegative(ms, DEFAULT_GRACE_MS)
}

export type PresenceReclaimPolicy = {
  /** 关掉后不按时间回收：回复完没人看的进程一直留着（数量上限仍按设置里的 keepAliveLimit 收） */
  enabled: boolean
  /** 看过之后离开的宽限 */
  graceMs: number
  /** 这一轮完成但没打开看过的宽限 */
  unreadGraceMs: number
}

/** 回收策略整套换掉（设置保存、服务启动时调用） */
export function setPresenceReclaimPolicy(p: Partial<PresenceReclaimPolicy>) {
  if (p.enabled !== undefined) reclaimEnabled = p.enabled
  if (p.graceMs !== undefined) graceMs = nonNegative(p.graceMs, DEFAULT_GRACE_MS)
  if (p.unreadGraceMs !== undefined) unreadGraceMs = nonNegative(p.unreadGraceMs, DEFAULT_UNREAD_GRACE_MS)
}

const grace = () => FIXED_GRACE_MS ?? graceMs
const unreadGrace = () => FIXED_UNREAD_GRACE_MS ?? unreadGraceMs

/** 任务 id → 正在看这个任务的页面 */
const viewers = new Map<string, Set<string>>()
/** 过了宽限、确认没人在看的任务 */
const left = new Set<string>()
/** 上报过在场的任务：没有页面在用（只调接口、测试）时不要替它把 CLI 留着 */
const reported = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let onIdle: ((taskId: string) => void) | undefined

/** 宽限期到了：让还在等用户的任务结束这一轮 */
export function setPresenceIdleHandler(fn: (taskId: string) => void) {
  onIdle = fn
}

/**
 * 这一轮回复完成、但用户还没打开看过（侧栏的橙点）时要不要留更久。
 * 由调用方提供判断，只有它知道任务现在的 turnDoneAt / turnSeenAt
 */
let keepUnread: ((taskId: string) => boolean) | undefined

export function setPresenceUnreadKeeper(fn: (taskId: string) => boolean) {
  keepUnread = fn
}

/**
 * 这个对话这一轮是不是还在跑（CLI 正在处理、在等它派出的子任务、名下子对话还在执行）。
 * 执行中的对话不受两个时长管：页面开着还是切到后台都一样，宽限到了也不结束这一轮。
 * 由调用方提供判定，只有它知道任务的状态（这里的 presence 模块只看页面在不在）
 */
let busy: ((taskId: string) => boolean) | undefined

export function setPresenceBusy(fn: (taskId: string) => boolean) {
  busy = fn
}

/** 页面打开、切到前台时 active；卸载、切到后台时 false */
export function setViewer(taskId: string, viewerId: string, active: boolean) {
  reported.add(taskId)
  if (active) {
    const set = viewers.get(taskId) ?? new Set()
    set.add(viewerId)
    viewers.set(taskId, set)
    left.delete(taskId)
    // 用户回来了：不再需要「等这一轮结束再算」的待回收标记
    pending.delete(taskId)
    const timer = timers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(taskId)
    }
    return
  }
  const set = viewers.get(taskId)
  set?.delete(viewerId)
  if (set?.size) return
  scheduleIdle(taskId)
}

/**
 * 没人在看时开始宽限计时。这一轮完成但还没看过（侧栏橙点）的对话也计时，只是宽限短一些：
 * 不收的话进程会一直挂着，而橙点只有用户点开才会消，等于永远不回收。
 * 看过之后要再调一次（见 rescheduleIfUnwatched），否则没人再触发计时。
 * 这一轮还在跑时到点不回收，见 evict
 */
function scheduleIdle(taskId: string) {
  if (timers.has(taskId)) return
  // 设置里关掉自动回收：保持老办法，没人看的对话一直留着
  if (!reclaimEnabled) return
  const ms = keepUnread?.(taskId) ? unreadGrace() : grace()
  timers.set(
    taskId,
    setTimeout(
      () => {
        timers.delete(taskId)
        evict(taskId)
      },
      Math.max(0, ms),
    ),
  )
}

/**
 * 过了宽限但这一轮还在跑、暂不能回收的对话。不排计时器（宽限期可以设成 0，
 * 拿 0ms 定时器反复重排会把事件循环打成每秒近千次自旋），等这一轮结束由 resetIdleCountdown 按整段重算
 */
const pending = new Set<string>()

/**
 * 回收一个会话：没人在看，让还在等下一句的 CLI 结束这一轮（用户回来时冷启动续接）。
 * 这一轮还在跑就不回收：切到后台的长任务不能因为「离开多久」被掐掉。
 * 这里只记一个待回收标记，不重排计时器——重排会把「执行期间过掉的时间」算进去，
 * 而宽限期为 0 时还会自旋；等它真的空下来（停在等下一句）再从那一刻算满一整段
 */
function evict(taskId: string) {
  const timer = timers.get(taskId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(taskId)
  }
  if (busy?.(taskId)) {
    pending.add(taskId)
    return
  }
  left.add(taskId)
  onIdle?.(taskId)
}

/**
 * 这一轮刚结束、开始保活：计时从现在起重新算满一整段。
 * - 之前因「还在跑」被叫停的（pending）：现在空下来了，从这一刻开始计
 * - 本来就在计时的：重置成整段，执行期间过掉的时间不算
 * - 没在计时（页面一直开着、没切走）：不排——在这里无条件排一个会按当时的「未读」状态定下 30 分钟，
 *   之后 /seen 再调 rescheduleIfUnwatched 也会因为 timers.has 直接返回，切走后迟迟不回收
 */
export function resetIdleCountdown(taskId: string) {
  const wasPending = pending.delete(taskId)
  const timer = timers.get(taskId)
  if (!timer && !wasPending) return
  if (timer) {
    clearTimeout(timer)
    timers.delete(taskId)
  }
  if (viewers.get(taskId)?.size) return
  scheduleIdle(taskId)
}

/** 这一轮已经看过了：如果已经没人在看，现在就按宽限期开始计时 */
export function rescheduleIfUnwatched(taskId: string) {
  if (viewers.get(taskId)?.size) return
  scheduleIdle(taskId)
}

/** 还有人在看吗：页面还没上报过时当作在看，避免刚开始执行就结束 */
export function isWatched(taskId: string) {
  return !left.has(taskId)
}

/**
 * 这个对话有没有页面在用（上报过在场、还没过宽限期）。
 * 没有页面时不要替用户把 CLI 留着等下一句：交互都在页面上，没有人会回来发消息
 */
export function hasViewer(taskId: string) {
  return reported.has(taskId) && !left.has(taskId)
}

/**
 * 现在有页面正开着这个对话（在前台）。和 hasViewer 不同：切走后的宽限期里 hasViewer 还算有人，这里不算。
 * 保活数量上限只放过这一种：宽限期里的对话也算进上限，不然一小时内点开过的对话全都豁免，上限形同虚设
 */
export function isViewing(taskId: string) {
  return (viewers.get(taskId)?.size ?? 0) > 0
}

/**
 * 这一轮刚完成：页面正开着就直接算看过（不亮橙点，也不因为未读一直留着进程）。
 * 没人在看时才需要等用户回来打开。
 */
export function seenWhileWatched(taskId: string) {
  return isViewing(taskId)
}

/** 任务删除、结束后清掉记录 */
export function forgetPresence(taskId: string) {
  const timer = timers.get(taskId)
  if (timer) clearTimeout(timer)
  timers.delete(taskId)
  pending.delete(taskId)
  viewers.delete(taskId)
  left.delete(taskId)
  reported.delete(taskId)
}
