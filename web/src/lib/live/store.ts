import { useCallback, useSyncExternalStore } from 'react'
import type { Task } from '@shared/schema'
import { taskLiveOf, type TaskLive } from '@shared/live/task-live'

/**
 * 对话的运行时状态（TaskLive）在页面上的那一份：和任务记录分开存（重构文档第 1、2 条）。
 *
 * 服务端回给界面的任务都带 live（列表、详情、实时推送、停止 / 改名顺手回的那份），
 * api 层和实时推送拿到就放进来（takeLive），任务记录本身照常替换。组件只经 useLive / useLiveOf 读状态，
 * 不自己拿 status / working / cliAlive 拼「在不在跑」。
 */
const lives = new Map<string, TaskLive>()
const subs = new Set<() => void>()
/** 每次有变化加一：列表类组件按它判断要不要重算 */
let version = 0

const subscribe = (cb: () => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}

/** 记下一份 live；内容没变时什么都不做（实时推送每 200ms 一次，不能每次都让侧栏重渲染） */
export function putLive(id: string, live: TaskLive | undefined) {
  if (!live) return
  const old = lives.get(id)
  if (old && JSON.stringify(old) === JSON.stringify(live)) return
  lives.set(id, live)
  version++
  for (const cb of subs) cb()
}

/** 从接口回来的任务上取下 live 放进来，返回不带 live 的任务记录 */
export function takeLive<T extends object>(x: T): T {
  if (!x || !('live' in x)) return x
  const { live, ...rest } = x as T & { live?: TaskLive; id?: string }
  if (rest.id) putLive(rest.id, live)
  return rest as T
}

/** 列表：每一份都取下 live */
export const takeLives = <T extends object>(list: T[]) => list.map(takeLive)

/** 对话删掉了：它的 live 也不要了 */
export function dropLive(id: string) {
  if (lives.delete(id)) {
    version++
    for (const cb of subs) cb()
  }
}

/** 还没拿到服务端那份时的占位：只按任务记录本身算（同一个 taskLiveOf），刚新建、刚导入的对话会短暂走到这里 */
function placeholder(task: Task): TaskLive {
  return taskLiveOf(task, { cliAlive: false, jobs: [], childrenWorking: 0, childrenCli: 0, childrenNeeds: 0 })
}

/** 一个对话的运行时状态（不订阅变化）：事件回调、列表筛选里用 */
export const liveFor = (task: Task): TaskLive => lives.get(task.id) ?? placeholder(task)

/** 组件里读一个对话的运行时状态：live 变了就重渲染。任务还没拿到（null）时是 undefined */
export function useLive(task: Task): TaskLive
export function useLive(task: Task | null | undefined): TaskLive | undefined
export function useLive(task: Task | null | undefined): TaskLive | undefined {
  const id = task?.id ?? ''
  const got = useSyncExternalStore(
    subscribe,
    () => lives.get(id),
    () => lives.get(id),
  )
  if (!task) return undefined
  return got ?? placeholder(task)
}

/** 只有 id 时（工具行、折叠行只拿到任务的几个字段）：还没拿到服务端那份时是 undefined */
export function useLiveById(id: string | undefined): TaskLive | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id ? lives.get(id) : undefined),
    () => (id ? lives.get(id) : undefined),
  )
}

/**
 * 列表类组件（侧栏、项目首页、标签页）：拿到一个取 live 的函数，任何一个对话的 live 变了都重渲染。
 * 返回的函数在没有变化时是同一个，可以放进 useMemo 的依赖
 */
export function useLiveOf(): (task: Task) => TaskLive {
  const v = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )
  // v 只用来在 live 变化时换一个新函数，函数体里不读它
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((task: Task) => liveFor(task), [v])
}
