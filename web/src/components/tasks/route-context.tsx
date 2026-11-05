import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import { toast } from '@/lib/toast'
import type { Task, TaskRoute } from '@shared/schema'
import { routeAnchorKey, routeAnchors, sameAnchors } from '@/lib/route-anchor'
import { RouteCard } from './RouteCard'

/**
 * 分诊卡在对话里的数据：哪条消息后面挂着哪几张（位置不常变，单独一层，
 * 消息列表据此决定哪些消息不收进折叠），和画卡片要的最新消息、改派动作（每次数据更新都变，只有卡片自己订阅）
 */
const Anchors = createContext<Map<string, TaskRoute[]>>(new Map())
const Live = createContext<{ task?: Task; onReroute?: (text: string) => Promise<void> }>({})

/** 对话页给消息列表提供分诊卡：send 发出改派消息（发给协调器，它下一轮照做） */
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
  const key = routeAnchorKey(task.messages, task.routes)
  const last = useRef<Map<string, TaskRoute[]>>(new Map())
  // 只在分诊或消息条数变了时重算：流式输出时正文一直在变，挂载位置不变。
  // 算出来和上次一样就沿用上次的引用：来一条新消息不该让每一轮回复都重画一遍
  const anchors = useMemo(() => {
    const next = routeAnchors(task.messages, task.routes)
    if (!sameAnchors(next, last.current)) last.current = next
    return last.current
    // 依赖只放签名：task 每次推送都是新对象，按它算会每 200ms 重算一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const live = useMemo(
    () => ({
      task,
      onReroute: send
        ? async (text: string) => {
            try {
              await send(text)
            } catch (e) {
              toast.error((e as Error).message)
            }
          }
        : undefined,
    }),
    [task, send],
  )
  return (
    <Anchors.Provider value={anchors}>
      <Live.Provider value={live}>{children}</Live.Provider>
    </Anchors.Provider>
  )
}

/** 哪些消息后面挂着分诊卡 */
export const useRouteAnchors = () => useContext(Anchors)

/**
 * 挂在这条消息后面的分诊卡；没有就什么都不画。
 * inline：插在 AI 回复里（和回复正文同一条竖线）；否则是用户消息下面那种带左侧图标列的（对不上回复的旧数据）
 */
export function InlineRoutes({ msgId, inline = true }: { msgId: string; inline?: boolean }) {
  const routes = useContext(Anchors).get(msgId)
  const { task, onReroute } = useContext(Live)
  if (!routes?.length) return null
  return (
    <RouteCard
      routes={routes}
      msgs={task?.messages ?? []}
      inline={inline}
      onReroute={task?.imported ? undefined : onReroute}
    />
  )
}
