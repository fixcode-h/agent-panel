import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import { toast } from '@/lib/toast'
import type { Task, TaskRoute } from '@shared/schema'
import {
  dispatchState,
  dispatchesOf,
  latestChildDispatch,
  reroutedIds,
  routeDispatches,
  type Dispatch,
  type DispatchState,
} from '@/lib/fold-dispatch'
import { sameAnchors } from '@/lib/route-anchor'
import { useChildList } from './child-open'
import type { ChildSummary } from './child-line'
import { DispatchRow } from './DispatchRow'

/**
 * 对话里的派单（新开 / 交回子对话、派子任务、后台命令、就地微改动）和挂在上面的分诊。
 * 分两层：位置（哪次调用是派单、对着哪几条分诊）不常变，单独一层；
 * 状态（对象办到哪了、改派动作）每次数据更新都变，只有派单行和折叠自己订阅
 */
interface DispatchIndex {
  byKey: Map<string, { d: Dispatch; routes: TaskRoute[] }>
  /** 对不上派单的分诊（旧数据）：挂在消息后面单独画 */
  orphan: Map<string, TaskRoute[]>
}
const Index = createContext<DispatchIndex>({ byKey: new Map(), orphan: new Map() })

interface DispatchLive {
  task?: Task
  children: ChildSummary[]
  state: (d: Dispatch, routes?: TaskRoute[]) => DispatchState
  onReroute?: (text: string) => Promise<void>
}
const Live = createContext<DispatchLive | null>(null)

/** 签名：分诊和消息条数没变时不重算位置（对话流式输出时每 200ms 来一次新数据，正文变了位置也不变） */
const indexKey = (task: Task) =>
  `${(task.routes ?? []).map((r) => r.id).join(',')}|${task.messages.length}|${task.messages.at(-1)?.id ?? ''}|${task.messages.at(-1)?.tools.length ?? 0}`

/** 对话页给消息列表提供派单和分诊：send 发出改派消息（发给协调器，它下一轮照做） */
export function RouteProvider({
  task,
  send,
  children,
}: {
  task: Task
  /** 不给时只读（导入的对话） */
  send?: (text: string) => Promise<void>
  children: ReactNode
}) {
  const kids = useChildList()
  const key = indexKey(task)
  const last = useRef<Map<string, TaskRoute[]>>(new Map())
  // 依赖只放签名：task 每次推送都是新对象，按它算会每 200ms 重算一次
  const index = useMemo(() => {
    const all = dispatchesOf(task.messages)
    const { byKey, orphan } = routeDispatches(task.messages, task.routes, all)
    // 旧数据的分诊位置算出来和上次一样就沿用上次的引用：来一条新消息不该让每一轮回复都重画一遍
    if (!sameAnchors(orphan, last.current)) last.current = orphan
    return {
      all,
      byKey: new Map(all.map((d) => [d.key, { d, routes: byKey.get(d.key) ?? [] }])),
      orphan: last.current,
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const live = useMemo<DispatchLive>(() => {
    const world = {
      task,
      children: kids,
      latestChild: latestChildDispatch(index.all),
      rerouted: reroutedIds(task.messages, task.routes),
    }
    return {
      task,
      children: kids,
      state: (d, routes) => dispatchState(d, routes ?? index.byKey.get(d.key)?.routes, world),
      onReroute:
        send && !task.imported
          ? async (text: string) => {
              try {
                await send(text)
              } catch (e) {
                toast.error((e as Error).message)
              }
            }
          : undefined,
    }
  }, [task, kids, index, send])
  return (
    <Index.Provider value={index}>
      <Live.Provider value={live}>{children}</Live.Provider>
    </Index.Provider>
  )
}

/** 哪些消息后面挂着对不上派单的分诊（旧数据） */
export const useRouteAnchors = () => useContext(Index).orphan

/**
 * 派单还没办完吗：折叠按它决定哪几行留在外面。没有提供（工作流节点、设计页、助手弹窗）时都算办完，
 * 和以前一样跟着折叠走
 */
export function useDispatchOpen(): ((d: Dispatch) => boolean) | undefined {
  const live = useContext(Live)
  return live ? (d) => live.state(d).open : undefined
}

/** 这些消息里的派单（按 key 取对象和分诊） */
export const useDispatchIndex = () => useContext(Index).byKey

/**
 * 一次工具调用（tool 为 -1 时是派出子任务的那条系统消息）如果是派单，画成派单行；不是就画 fallback。
 * 后台命令、启动工作流这两种没有分诊，照旧画原来的工具行
 */
export function DispatchSlot({ msgId, tool, fallback }: { msgId: string; tool: number; fallback?: ReactNode }) {
  const entry = useContext(Index).byKey.get(`${msgId}#${tool}`)
  const live = useContext(Live)
  if (!entry || !live || entry.d.kind === 'job' || entry.d.kind === 'run') return <>{fallback}</>
  return (
    <DispatchRow
      d={entry.d}
      routes={entry.routes}
      state={live.state(entry.d, entry.routes)}
      task={live.task}
      kids={live.children}
      onReroute={live.task?.imported ? undefined : live.onReroute}
    />
  )
}

/** 挂在这条消息后面、对不上派单的分诊（旧数据）：同一个派单行，只是没有状态 */
export function InlineRoutes({ msgId }: { msgId: string; inline?: boolean }) {
  const routes = useContext(Index).orphan.get(msgId)
  const live = useContext(Live)
  if (!routes?.length) return null
  return (
    <div className="proc-list flex flex-col">
      {routes.map((r) => (
        <DispatchRow key={r.id} routes={[r]} task={live?.task} onReroute={live?.onReroute} />
      ))}
    </div>
  )
}
