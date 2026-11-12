/**
 * 父对话页的子对话列表：状态、拉取（停下原因、本地已读）、首拉、轮询和推送信号。
 * 从 TaskView.tsx 拆出来（文件行数上限，见 docs/lessons/file-caps.md）；两个 hook 分别在原来那几行的位置调用，
 * hook 和 effect 的先后不变
 */
import { useLiveById } from '@/lib/live/store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { StopReason } from '@shared/schema'
import { childSeenLocally, childSpinning } from '@shared/task'
import { api, type TaskPage } from '@/lib/api'
import type { useLoadTrace } from '@/lib/useLoadTrace'
import { type ChildSummary } from './child-line'

/**
 * 子对话列表的刷新间隔：有子对话在跑（转圈）时看勤一点，都静止时只是等它再动，没必要每 4 秒问一遍。
 * 没有子对话时根本不轮询（见下文）
 */
export const CHILD_POLL_ACTIVE_MS = 4000
export const CHILD_POLL_IDLE_MS = 15_000

/**
 * 内容没变就沿用原来的数组：子对话栏 4 秒轮询一次，每次都换新数组会让整个对话页（连同几百条消息）重渲染，
 * 子对话一多、消息一长，打字和滚动都会跟着一顿一顿的
 */
export function sameJson<T>(cur: T, next: T): T {
  return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
}

/**
 * 本地刚点开过的子对话按已读算：子对话页自己会发 /seen，但 4 秒一次的轮询可能抢在它前面，
 * 把刚消失的未读点又画回来。只覆盖「点开那一刻的那一轮」：服务端换了新的完成时间（它又跑完一轮）时不按已读算，
 * 那一轮归子对话页自己的 /seen 管，不然会和侧栏的橙点对不上
 */
export function withLocalSeen(c: ChildSummary, viewed: Map<string, string>): ChildSummary {
  const seenAt = viewed.get(c.id)
  return seenAt && childSeenLocally(c, seenAt) ? { ...c, turnSeenAt: seenAt } : c
}

/** 子对话列表的首拉、轮询和推送信号（对话页里原来那三段 effect，先后不变）：父对话页开着时才拉 */
export function useChildPolling(task: TaskPage | null, trace: ReturnType<typeof useLoadTrace>, list: ChildList) {
  const { children, setChildren, childrenReload, loadChildren } = list
  // 子对话列表：父对话页开着时定时刷新状态和摘要；子对话自己不显示子对话。
  // 这里只是只读查询，不给子对话发 presence、也不预热它们的 CLI
  useEffect(() => {
    // 任务还没拿到时不动：这一步是「还没轮到」，不是「没有子对话」
    if (!task?.id) return
    if (task.parentTaskId) {
      setChildren([])
      // 子对话自己没有子对话列表：这步按「不适用」处理，日志才能走完
      trace.skip('children', t('这个对话没有子对话'))
      return
    }
    let alive = true
    // 只有第一次拉取记进加载日志：后面的轮询和「打开对话」无关
    const load = (tracked = false) => {
      if (tracked) trace.start('children')
      return loadChildren(task.id)
        .then((list) => {
          if (alive) setChildren((cur) => sameJson(cur, list))
        })
        .catch((e) => {
          if (tracked) trace.fail('children', (e as Error).message)
        })
        .finally(() => {
          if (tracked) trace.finish('children')
        })
    }
    // 轮询和推送信号都走同一个函数（下面的 effect 拿不到这个闭包）
    childrenReload.current = load
    void load(true)
    return () => {
      alive = false
      childrenReload.current = async () => {}
    }
    // 任务 id 变了才重新订阅；子对话的变化靠下面的轮询和推送信号
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.parentTaskId])
  // 子对话列表的轮询间隔：没有子对话就一次也不发（子对话产生时由推送的统计数和上报信号拉回来，见下）。
  // 有子对话时按有没有在跑分两档：都在跑 4 秒，都静止 15 秒——静态的子对话只是等它再动，
  // 每 4 秒问一遍服务端（每个子对话还要跑一次 git）就是纯空转
  const childrenWorking = children.some(childSpinning)
  useEffect(() => {
    if (!task?.id || task.parentTaskId || !children.length) return
    const timer = setInterval(
      () => void childrenReload.current(),
      childrenWorking ? CHILD_POLL_ACTIVE_MS : CHILD_POLL_IDLE_MS,
    )
    return () => clearInterval(timer)
    // childrenReload 是 ref（从 useChildList 传进来，lint 认不出是 ref），对象本身不会变，写进依赖不会多跑
  }, [task?.id, task?.parentTaskId, children.length, childrenWorking, childrenReload])
  // 子对话那边变了就重取子对话列表：待选择的提问变了（在子对话里选完、交给父对话决定），
  // 或者收到子对话的上报（panel === 'child'，含「子对话已完成」）。
  // 名下子对话的计数（childrenWorking / childrenCli）变了也要重取：子对话刚开、刚跑完的时候
  // 任务本身不一定会推新消息，靠这两个数把列表拉回来
  // 列表只读子对话自己的状态、本地不改写：子对话先置完成并上报，这里才跟着变，不抢在它前面
  const childSignal = task?.parentTaskId
    ? ''
    : [
        (task?.messages ?? []).filter((m) => m.panel === 'child').at(-1)?.id ?? '',
        ...(task?.messages ?? [])
          .filter((m) => m.panel === 'ask' && m.ask?.answer === undefined && !m.ask?.delegated)
          .map((m) => m.id),
      ].join(',')
  // 后代在等你确认的个数也算：子对话弹出权限确认时它不一定推新消息，靠这个数把列表（和确认行）拉回来
  // 这几个计数在服务端给的 live 里（web/src/lib/live/store.ts）
  const live = useLiveById(task?.id)
  const childScan = `${live?.childrenWorking ?? 0}|${live?.childrenCli ?? 0}|${live?.childrenNeeds ?? 0}`
  const childSignalSeen = useRef({ taskId: '', key: '' })
  useEffect(() => {
    if (!task?.id || task.parentTaskId) return
    const key = `${childSignal}|${childScan}`
    const seen = childSignalSeen.current
    // 换到另一条对话（或第一次）：只记下当前的信号，首拉已经在上面那次 effect 里做了
    if (seen.taskId !== task.id) {
      childSignalSeen.current = { taskId: task.id, key }
      return
    }
    if (seen.key === key) return
    childSignalSeen.current = { taskId: task.id, key }
    void childrenReload.current()
    // 只在子对话那边的状态有变化（上报、提问状态、子对话计数）时刷新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [childSignal, childScan, task?.id, task?.parentTaskId])
}

/** 父对话页的子对话列表：状态、拉一次的函数和本地记着的停下原因、已读（对话页里原来那几行，先后不变） */
export function useChildList() {
  const [children, setChildren] = useState<ChildSummary[]>([])
  // 子对话列表的重新拉取：首拉、轮询和推送信号都走它（见下面子对话列表的 effect）
  const childrenReload = useRef<(tracked?: boolean) => Promise<void>>(async () => {})
  // 子对话的停下原因只有完整任务上有（/children 给的是摘要）：停下的各取一次，行上才能写清是谁结束的
  // （见 stopReasonText）。停下后原因不会变，取到的记在 ref 里，4 秒一次的轮询不再重复问
  const childStopReasons = useRef(new Map<string, StopReason>())
  /** 在右栏点开过的子对话：点开时那一轮的 turnDoneAt（见 withLocalSeen） */
  const viewedChildren = useRef(new Map<string, string>())
  /**
   * children 的最新一份：openChildRow 用 useCallback 固定了首次渲染的 openChildIn（消息行不跟着重画），
   * 那里直接读 state 会永远是空数组，点开时就记不到这一轮
   */
  const childrenRef = useRef<ChildSummary[]>([])
  childrenRef.current = children
  const loadChildren = useCallback(async (id: string) => {
    const raw = await api.taskChildren(id)
    const finish = (list: ChildSummary[]) => list.map((c) => withLocalSeen(c, viewedChildren.current))
    // 服务端已经给了原因（空字符串是没记）：不用再为每个停下的子对话取一遍完整任务，几十个子对话就是几十份几 MB 的对话
    if (raw.every((c) => c.stopReason !== undefined))
      return finish(raw.map((c): ChildSummary => ({ ...c, stopReason: c.stopReason || undefined })))
    const list = raw.map((c): ChildSummary => ({ ...c, stopReason: undefined }))
    // 又跑起来了就清掉旧原因：下次停下可能是另一个来源
    for (const c of list) if (c.status !== 'stopped') childStopReasons.current.delete(c.id)
    await Promise.all(
      list
        .filter((c) => c.status === 'stopped' && !childStopReasons.current.has(c.id))
        .map((c) =>
          api
            .task(c.id)
            .then((t) => {
              if (t.stopReason) childStopReasons.current.set(c.id, t.stopReason)
            })
            // 没取到就下次轮询再试：先按「已暂停」显示，不在这里编个原因
            .catch(() => {}),
        ),
    )
    return finish(
      list.map((c) => (c.status === 'stopped' ? { ...c, stopReason: childStopReasons.current.get(c.id) } : c)),
    )
  }, [])
  return { children, setChildren, childrenReload, viewedChildren, childrenRef, loadChildren }
}
export type ChildList = ReturnType<typeof useChildList>
