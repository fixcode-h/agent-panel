/**
 * 对话页的数据：打开时 GET 一份（只取最近一段消息）、拿到再建 SSE、往前翻页、记已读和在场、打开过程的加载日志，
 * 以及从搜索结果点进来时定位到那条消息。从 TaskView.tsx 拆出来（重构文档第 13 条）：
 * 页面只拿 task、apply 和加载日志，怎么取、怎么合并都在这里
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { Task, TaskSeenResult } from '@shared/schema'
import { api, type TaskPage } from '@/lib/api'
import { useLive } from '@/lib/live/store'
import { liveFollow } from '@/lib/live/follow'
import { ANCHOR_RETRY_MS, ANCHOR_TRIES, jumpToMessage } from '@/lib/message-anchor'
import { useTaskStream } from '@/lib/task-stream'
import { withTurnSeenAt } from '@/lib/tasks'
import { toast } from '@/lib/toast'
import { useLoadTrace } from '@/lib/useLoadTrace'
import { OPEN_MESSAGE_LIMIT } from '../task-view-pane'
import { useTaskPresence } from '../task-view-presence'
import { useSummaryPush } from '../task-view-summary'

export interface TaskLoadCtx {
  taskId: string
  /** 地址里带的消息 id（从搜索结果点进来） */
  jumpMsg?: string
  tasks: Task[]
  upsertTask: (t: Task) => void
  /** 往前翻到了更早的消息：页面把本地的限长也打开，刚翻回来的要能立刻看到 */
  onOlder: () => void
}

export function useTaskLoad(c: TaskLoadCtx) {
  const { taskId } = c
  const [task, setTask] = useState<TaskPage | null>(null)
  useJumpToMessage(c.jumpMsg, task)
  // 打开这条对话的加载日志：各步在请求真正发起 / 返回的地方记，界面按它逐行打日志
  const trace = useLoadTrace()
  // 任务数据到了以后日志盖在对话上淡出，淡完就卸载（不一直占着屏幕）
  const [traceHidden, setTraceHidden] = useState(false)
  // 「渲染消息」这一步只记第一次：记下是为哪个任务记的，换对话时不能延用旧的那次结果
  const traceRenderFor = useRef('')
  // 正在往前翻更早的消息（首屏只取了最近一段），按钮上有个进行中的状态
  const [earlierLoading, setEarlierLoading] = useState(false)
  // 打开对话时先 GET 一份（首屏只取最近一段），拿到它再建 SSE：有整份的版本时带上它，
  // 首包就只补发增量；null 表示这一轮还没拿到第一份（GET 还没回来 / 刚换对话）
  const [streamBoot, setStreamBoot] = useState<{ rev: string; task: TaskPage | null } | null>(null)
  // 全局列表的摘要节流（task-view-summary.ts）：lastTask 是手上最新的一份，truncated 记着是不是只有最近一段
  const { lastTask, truncated, summaryTimer, pushSummary } = useSummaryPush(c.tasks, c.upsertTask)
  const apply = (raw: TaskPage) => {
    // 数据到手，开始画：渲染这一步从这一刻算到两帧画完（含 React 把消息挂进 DOM 的时间）。
    // 两条路都会经过这里（GET 与 SSE 首包谁先到都可能），所以起始点记在这，不记在某一条请求的 then 里；
    // 已经记过完成的不再改（startStep 对非 waiting 的步骤原样返回）
    trace.start('render')
    // 运行时状态（live）在 api 层、实时推送里已经取下放进 live/store.ts，这里只换任务记录（见 web/src/lib/live/store.ts）。
    // 分页信息（messageTotal / messageHasMore）跟着这次那份：转截断了就该能翻页，SSE 整份到了就该收起来
    const next = raw
    setTask(next)
    // 从「只有一段」恢复到整份：侧栏摘要要立刻换回第一条用户消息，不等 1 秒节流
    const wasTruncated = truncated.current
    truncated.current = !!next.messageHasMore
    pushSummary(next, wasTruncated)
  }
  // 服务端还没给的最早那段（见 OPEN_MESSAGE_LIMIT）：往前翻一页，接在现在的对话前面。
  // 只用它自己那一页的消息，以手上那份为准拼：翻页期间 SSE 可能又推了新消息
  const loadEarlier = async () => {
    const cur = lastTask.current
    const first = cur?.messages[0]?.id
    if (!cur || !first || earlierLoading) return
    setEarlierLoading(true)
    try {
      const raw = await api.task(taskId, { limit: OPEN_MESSAGE_LIMIT, before: first })
      // 锚点那条已经不在（返工删掉了）：不拼一段不连续的历史，重新取最后一页
      if (raw.messageAnchorMissing) {
        apply(await api.task(taskId, { limit: OPEN_MESSAGE_LIMIT }))
        toast(t('对话已经变化，已重新加载'))
        return
      }
      const now = lastTask.current
      if (!now || now.id !== raw.id) return
      const ids = new Set(now.messages.map((m) => m.id))
      const older = raw.messages.filter((m) => !ids.has(m.id))
      // 分页信息跟着这一次的响应走：翻到最后一页时按钮要收起来
      const next = { ...now, messageTotal: raw.messageTotal, messageHasMore: raw.messageHasMore }
      apply(older.length ? { ...next, messages: [...older, ...now.messages] } : next)
      // 用户点了往前走，就把本地那段限长也打开：刚翻回来的这 50 条要能立刻看到，
      // 而不是数据接上了、屏上还只画最后 30 段
      if (older.length) c.onOlder()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setEarlierLoading(false)
    }
  }
  // 服务端只回「这一轮看到哪」（整份对话不再传回来）：合进本地那份，侧栏橙点跟着消失，
  // 未读判定仍在 shared/task 的 taskTurnUnread，这里不改规则
  const applySeen = (seen: TaskSeenResult) => {
    const cur = lastTask.current
    if (cur) {
      const next = withTurnSeenAt(cur, seen.turnSeenAt)
      if (next !== cur) {
        setTask(next)
        pushSummary(next)
      }
      return
    }
    // 首次打开时 /seen 常常比 GET /:id 先回来（那份要序列化整份对话）：这时本地还没有任务，
    // 只能先把全局列表里那条摘要换掉，侧栏橙点不用等整份对话到齐
    const listed = c.tasks.find((x) => x.id === taskId)
    if (!listed) return
    const patched = withTurnSeenAt(listed, seen.turnSeenAt)
    if (patched !== listed) c.upsertTask(patched)
  }
  useEffect(
    () => () => {
      if (summaryTimer.current) clearTimeout(summaryTimer.current)
    },
    // summaryTimer 是 useSummaryPush 里的 ref，对象不会变：仍然只在卸载时清一次
    [summaryTimer],
  )

  useEffect(() => {
    // 换对话：日志从头记（同一个组件实例可能被复用），盖住对话的那一层也重新出来
    trace.reset()
    setTraceHidden(false)
    traceRenderFor.current = ''
    // 换了对话：先不建 SSE，等这一条的 GET 回来（避免拿上一条的版本去连）
    setStreamBoot(null)
    truncated.current = false
    trace.start('task')
    // 演示版没有服务端推送，改用轮询：等任务数据到了再按「有没有在跑」判定这一步（见下面的演示版分支）
    if (!import.meta.env.VITE_DEMO) trace.start('stream')
    api
      .task(taskId, { limit: OPEN_MESSAGE_LIMIT })
      .then((raw) => {
        trace.finish('task')
        // SSE 首包可能先到（例如重连过），它带的是整份对话：不能再用只取了最近一段的这份盖回去
        if ((lastTask.current?.messages.length ?? 0) <= raw.messages.length) apply(raw)
        // 拿到第一份再建 SSE：整份都在这一份里时带上版本（服务端首包只补发增量），
        // 并把这一份作为合并增量的基线
        setStreamBoot({ rev: raw.messageRev ?? '', task: lastTask.current ?? raw })
      })
      .catch((e) => {
        // 错误原文照给用户看；后面的步骤标成「未执行」——它们不是卡住了，是没轮到
        trace.fail('task', (e as Error).message)
        trace.abort()
        toast.error((e as Error).message)
        // GET 失败时照旧连 SSE：没有基线也没有版本，服务端会发整份
        setStreamBoot({ rev: '', task: null })
      })
    // 换任务时取一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // 记已读、在场心跳（task-view-presence.ts）
  useTaskPresence(taskId, task, trace, applySeen)

  // 运行时状态（状态、等什么、后台命令、CLI 存活）只读服务端给的 live（web/src/lib/live/store.ts）
  const live = useLive(task)
  // 跟不跟实时更新：在跑、有后台命令、诊断报告等确认（lib/live/follow.ts）
  const { running, jobRunning, follow } = liveFollow(task, live)
  // 演示版把轮询当作实时更新来记：按「打开那一刻有没有在跑」判定一次，之后任务再开始 / 停下不重记
  // （加载日志记的是这次打开；startStep / skipStep 都只对 waiting 生效，跟着 running 反复切换会卡在旧状态）。
  // 轮询自己的起停由 useTaskStream 的 start / stop 包住：打开时在跑、首轮回来前就停了，也会被收回来
  const demoTraceStream = useRef('')
  useEffect(() => {
    if (!import.meta.env.VITE_DEMO || !task) return
    if (demoTraceStream.current === task.id) return
    demoTraceStream.current = task.id
    if (running || jobRunning) trace.start('stream')
    else trace.skip('stream', t('这条对话没有实时更新'))
    // 只在任务到的第一刻判一次；trace 的函数是稳定的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, running, jobRunning])
  useTaskStream(
    taskId,
    follow,
    apply,
    {
      // 演示版把轮询当作实时更新：轮询在跑才算这一步开始，停下时收回来（正式版走 SSE，不调这两个）
      start: () => trace.start('stream'),
      stop: () => trace.finish('stream', t('实时更新已停止')),
      // 首包到了：正常首包直接完成；之前失败过一次又重连上的，把那条失败收回来
      // （否则重连成功后面板会永久停在「加载失败」，对话其实已经好了）
      open: () => {
        trace.recover('stream', t('重新连上了'))
        trace.finish('stream')
      },
      fail: (error) => trace.fail('stream', error),
    },
    streamBoot,
  )

  // 消息真的画到屏幕上才算「渲染完成」：两帧之后记，第一帧 React 把消息写进 DOM，第二帧浏览器画出来。
  // 认任务 id：两条对话切得很快、或者消息还在增量推送时，旧的那次 rAF 不能把后一条记成已渲染
  useEffect(() => {
    if (!task || traceRenderFor.current === task.id) return
    const id = task.id
    const count = task.messages.length
    traceRenderFor.current = id
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (traceRenderFor.current !== id) return
        trace.finish('render', t('{n} 条消息', { n: count }))
      }),
    )
    // 只跟着任务 id；同一条对话的消息增量不重记；trace 的函数是稳定的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task])

  return {
    task,
    setTask,
    apply,
    lastTask,
    live,
    running,
    trace,
    traceHidden,
    hideTrace: () => setTraceHidden(true),
    earlierLoading,
    loadEarlier,
  }
}

/**
 * 从搜索结果点进来时定位到那条消息：消息是异步加载的（被折叠的过程还要先展平），多试几次再放弃。
 * 跳转成功后地址里的 msg 还在，同一个 (对话, 消息) 只定位一次：不然每来一条新消息（条数变了）都会把视图滚回那条旧命中
 */
function useJumpToMessage(jumpMsg: string | undefined, task: TaskPage | null) {
  const anchored = useRef('')
  useEffect(() => {
    if (!jumpMsg || !task) return
    const mark = `${task.id}:${jumpMsg}`
    if (anchored.current === mark) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      if (jumpToMessage(jumpMsg)) {
        anchored.current = mark
        return
      }
      if (++tries >= ANCHOR_TRIES) return
      timer = setTimeout(attempt, ANCHOR_RETRY_MS)
    }
    attempt()
    return () => clearTimeout(timer)
    // 依赖只看 id 和消息条数：整个 task 每个增量都是新对象，按它比会每 200ms 重新定位一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpMsg, task?.id, task?.messages.length])
}
