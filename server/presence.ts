/**
 * 对话页面是否还开着：CLI 在 MCP 工具上等用户下一句时，只有页面还开着才继续等。
 * 切走（页面卸载或隐藏）后给一段宽限，期间切回来还能直接接着说；过了宽限让 CLI 结束这一轮。
 * 宽限时长在设置里改（presenceGraceMinutes），环境变量 AGENT_PANEL_PRESENCE_GRACE_MS 优先，测试用
 */
const FIXED_GRACE_MS = process.env.AGENT_PANEL_PRESENCE_GRACE_MS
  ? Number(process.env.AGENT_PANEL_PRESENCE_GRACE_MS)
  : undefined
const DEFAULT_GRACE_MS = 60 * 60_000

let graceMs = DEFAULT_GRACE_MS

/** 改宽限期（设置保存后调用）；0 表示页面切走就让 CLI 结束这一轮 */
export function setPresenceGraceMs(ms: number) {
  graceMs = Number.isFinite(ms) ? Math.max(0, ms) : DEFAULT_GRACE_MS
}

const grace = () => FIXED_GRACE_MS ?? graceMs

/** 任务 id → 正在看这个任务的页面 */
const viewers = new Map<string, Set<string>>()
/** 过了宽限、确认没人在看的任务 */
const left = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let onIdle: ((taskId: string) => void) | undefined

/** 宽限期到了：让还在等用户的任务结束这一轮 */
export function setPresenceIdleHandler(fn: (taskId: string) => void) {
  onIdle = fn
}

/**
 * 这一轮回复完成、但用户还没打开看过（侧栏的橙点）时要不要留着进程。
 * 这类对话没有页面开着，不能按宽限期回收，否则用户回来时 CLI 已经退出了。
 * 由调用方提供判断，只有它知道任务现在的 turnDoneAt / turnSeenAt
 */
let keepUnread: ((taskId: string) => boolean) | undefined

export function setPresenceUnreadKeeper(fn: (taskId: string) => boolean) {
  keepUnread = fn
}

/** 页面打开、切到前台时 active；卸载、切到后台时 false */
export function setViewer(taskId: string, viewerId: string, active: boolean) {
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
 * 没人在看时开始宽限计时。这一轮完成但还没看过（侧栏橙点）时先不计时：
 * 用户回来还要接着聊，回收了就得重新启动 CLI。
 * 看过之后要再调一次（见 rescheduleIfUnwatched），否则没人再触发计时，进程会一直留着
 */
function scheduleIdle(taskId: string) {
  if (timers.has(taskId)) return
  if (keepUnread?.(taskId)) return
  timers.set(
    taskId,
    setTimeout(
      () => {
        timers.delete(taskId)
        // 宽限期内用户还是没看这一轮完成：继续留着
        if (keepUnread?.(taskId)) return
        left.add(taskId)
        onIdle?.(taskId)
      },
      Math.max(0, grace()),
    ),
  )
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

/** 任务删除、结束后清掉记录 */
export function forgetPresence(taskId: string) {
  const timer = timers.get(taskId)
  if (timer) clearTimeout(timer)
  timers.delete(taskId)
  viewers.delete(taskId)
  left.delete(taskId)
}
