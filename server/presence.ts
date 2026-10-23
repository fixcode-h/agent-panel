/**
 * 对话页面是否还开着：CLI 在 MCP 工具上等用户下一句时，只有页面还开着才继续等。
 * 切走（页面卸载或隐藏）后给一段宽限，期间切回来还能直接接着说；过了宽限让 CLI 结束这一轮。
 * 宽限时长在设置里改（presenceGraceMinutes / unreadGraceMinutes），环境变量优先，测试用。
 * 保活会话的数量上限（keepAliveLimit）不在这里：那个要看哪些任务还在跑、名下有没有子对话，
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

/** 页面打开、切到前台时 active；卸载、切到后台时 false */
export function setViewer(taskId: string, viewerId: string, active: boolean) {
  reported.add(taskId)
  if (active) {
    const set = viewers.get(taskId) ?? new Set()
    set.add(viewerId)
    viewers.set(taskId, set)
    left.delete(taskId)
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
 * 看过之后要再调一次（见 rescheduleIfUnwatched），否则没人再触发计时
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

/** 回收一个会话：没人在看，让还在等下一句的 CLI 结束这一轮（用户回来时冷启动续接） */
function evict(taskId: string) {
  const timer = timers.get(taskId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(taskId)
  }
  left.add(taskId)
  onIdle?.(taskId)
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
 * 这一轮刚完成：页面正开着就直接算看过（不亮橙点，也不因为未读一直留着进程）。
 * 没人在看时才需要等用户回来打开。
 */
export function seenWhileWatched(taskId: string) {
  return (viewers.get(taskId)?.size ?? 0) > 0
}

/** 任务删除、结束后清掉记录 */
export function forgetPresence(taskId: string) {
  const timer = timers.get(taskId)
  if (timer) clearTimeout(timer)
  timers.delete(taskId)
  viewers.delete(taskId)
  left.delete(taskId)
  reported.delete(taskId)
}
