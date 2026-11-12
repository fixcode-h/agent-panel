/**
 * 对话页上「开着哪一块」的状态：右栏开着哪个子对话、中间开着哪次运行、文件面板和功能面板收没收、
 * 会话栏开没开、Chat 右栏开没开。大都按对话记在本地（切走窗口、重新加载后还是原来那样）；
 * 子对话自己的右栏（pane）不记也不读。从 TaskView.tsx 拆出来（重构文档第 13 条）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolUse } from '@shared/schema'
import { RUN_NO } from '@shared/flow-run'
import type { TaskPage } from '@/lib/api'
import { OPEN_CHILD_EVENT, SHOW_PARENT_EVENT } from '@/lib/ai-window'
import { useOwnedRuns } from '@/lib/owned-runs'
import { startedRun } from '@/lib/tasks'
import type { RunTab } from '../RunCard'
import { sameJson, withLocalSeen, type useChildList } from '../task-view-children'
import {
  CHAT_RAIL_KEY,
  SESSION_BAR_KEY,
  readFilesFolded,
  readPaneChild,
  readPaneRun,
  readReportFolded,
  readStored,
  writeFilesFolded,
  writePaneChild,
  writePaneRun,
  writeReportFolded,
  writeStored,
} from '../task-view-pane'

export interface TaskPanesCtx {
  taskId: string
  pane?: boolean
  task: TaskPage | null
  childList: ReturnType<typeof useChildList>
  /** 分析报告那条回复的 id：出了新的报告时收起过的功能面板重新打开 */
  reportId: string
}

export function useTaskPanes(c: TaskPanesCtx) {
  const { taskId, pane, task } = c
  const { children, setChildren, viewedChildren, childrenRef, loadChildren } = c.childList
  // 父对话里的子对话：点开在右栏看，右栏同一时间只显示一个。
  // 右栏开着哪个按父任务 id 记在本地：切走窗口再回来、页面重新加载后还是原来那个
  const [openChild, setOpenChild] = useState(() => (pane ? '' : readPaneChild(taskId)))
  // 中间显示父对话还是另一个页签（子对话 / 运行）：页签开着时点父对话页签切回来，页签本身不关。
  // 打开对话时先显示父对话（地址指的就是它），上次开着的子对话 / 运行页签留在页签条上，点了才切过去
  const [onParent, setOnParent] = useState(true)
  /** 右栏当前打开的子对话的最新一份：openChildIn 同样被固定的闭包读，不能直接读 state */
  const openChildRef = useRef('')
  openChildRef.current = openChild
  // 宽屏右栏收起：让对话用满整个宽度，收起的按钮还在页签条。默认开着，用户收起过就按本地记着的来
  const [filesFolded, setFilesFolded] = useState(() => readFilesFolded(taskId))
  const [sessionOpen, setSessionOpen] = useState(() => readStored(SESSION_BAR_KEY) !== 'closed')
  // 会话栏和右侧文件栏并排放不下时谁让：后打开的那个留着（默认会话栏，照 Claude Code）
  // auto：还没手动开过哪一边。文件栏放不下时默认让给会话栏；Chat 页的右栏（代码、来源、附件）是聊天自己的内容，默认它留着
  const [lastRail, setLastRail] = useState<'session' | 'files' | 'auto'>('auto')
  // AI 分析对话的功能面板（分析报告、教训评审、项目设置）：宽屏是对话右边的一栏，默认开着、收起按对话记住；
  // 窄屏和放在父对话右栏里（pane）时没有地方并排，点标题栏的按钮盖在对话上打开
  const [reportFolded, setReportFolded] = useState(() => readReportFolded(taskId))
  const [reportCover, setReportCover] = useState(false)
  // 对话里点开的运行卡片：右边看这一次运行的实时输出
  const [openRun, setOpenRun] = useState(() => (pane ? 0 : readPaneRun(taskId)))
  // 子对话面板里点开的一次运行：在这块面板内换成那次运行的视图（带返回），不另开一栏。
  // run 为 0 是认不回来是哪次运行（调用失败、还没开始），按「没有启动运行」显示原因
  const [paneRun, setPaneRun] = useState<{ run: number; tool?: ToolUse; tab?: RunTab } | null>(null)
  // 工作流运行在右栏打开时直接看它的流程图（运行只有一次，见 shared/flow-run.ts 的 RUN_NO）；每次只自动开一回，返回后不再弹回来
  const flowShown = useRef('')
  useEffect(() => {
    if (!pane || !task?.flowRun || flowShown.current === task.id) return
    flowShown.current = task.id
    setPaneRun({ run: RUN_NO, tab: 'flow' })
    // 只看对话换了没有、是不是工作流运行：task 每次推送都是新对象，按它跑会反复判断
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, task?.id, !!task?.flowRun])
  const [chatRailOn, setChatRailOn] = useState(() => readStored(CHAT_RAIL_KEY) !== 'closed')
  const toggleChatRail = () =>
    setChatRailOn((v) => {
      writeStored(CHAT_RAIL_KEY, v ? 'closed' : '')
      return !v
    })

  // 右栏开着哪个子对话、哪一次运行：挂载时按父任务 id 读回来（切走窗口、重新加载后不丢）。
  // 子对话自己的右栏（pane）不记也不读
  useEffect(() => {
    if (pane) {
      setOpenChild('')
      setOpenRun(0)
      return
    }
    setOpenChild(readPaneChild(taskId))
    setOpenRun(readPaneRun(taskId))
    setFilesFolded(readFilesFolded(taskId))
    setReportFolded(readReportFolded(taskId))
    setReportCover(false)
    // 别处（AI 分析窗口「去对话里看」）要在这个对话的右栏打开某个子对话：已经开着的对话页马上切过去
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ parentId: string; childId: string }>).detail
      if (d?.parentId !== taskId) return
      // 先刷新子对话列表：刚开的子对话还不在列表里，直接切过去会被「已经不在」那条判断清掉
      void loadChildren(taskId)
        .then((list) => setChildren((cur) => sameJson(cur, list)))
        .catch(() => {})
        .finally(() => {
          setOpenChild(d.childId)
          setOpenRun(0)
        })
    }
    const onShowParent = (e: Event) => {
      if ((e as CustomEvent<string>).detail === taskId) setOnParent(true)
    }
    window.addEventListener(OPEN_CHILD_EVENT, onOpen)
    window.addEventListener(SHOW_PARENT_EVENT, onShowParent)
    return () => {
      window.removeEventListener(OPEN_CHILD_EVENT, onOpen)
      window.removeEventListener(SHOW_PARENT_EVENT, onShowParent)
    }
    // 只在换了对话时重新挂：loadChildren 每次渲染都是同一份逻辑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, pane])

  // 文件面板的开合：按对话记在本地，下次打开还是用户最后一次选的那样。子对话自己的右栏（pane）不写
  const toggleFiles = () => {
    setFilesFolded(!filesFolded)
    if (!pane) writeFilesFolded(taskId, !filesFolded)
  }
  // 功能面板的开合：同样按对话记在本地，子对话自己的右栏不写
  const foldReport = (folded: boolean) => {
    setReportFolded(folded)
    if (!pane) writeReportFolded(taskId, folded)
  }
  // 右栏切换的统一入口：记在本地，下次打开还是这一栏。子对话自己的右栏（pane）不写
  const openChildIn = (id: string) => {
    // 点开就算读过：只记点开这一拍的那一轮，用来挡住 4 秒轮询把刚消失的未读点画回来；
    // 它之后又跑完的新一轮不归这里管——那一轮由子对话页自己的 /seen 记，这里跟着轮询更新的话
    // 会和侧栏的橙点对不上（服务端还没看过，父对话列表却当成看过了）。
    // 右栏已经开着这一个时（id 没变）也不清点：pane 不重挂载就不会再发 /seen，
    // 本地当成看过而服务端还记着没看，刷新后点又回来
    const viewed = id && id !== openChildRef.current ? childrenRef.current.find((x) => x.id === id) : undefined
    if (viewed?.turnDoneAt) {
      viewedChildren.current.set(id, viewed.turnDoneAt)
      // 当前这份列表立刻按已读显示，不用等下一次轮询：换开别的子对话后这条不再被 viewing 挡住
      setChildren((cur) => cur.map((x) => withLocalSeen(x, viewedChildren.current)))
    }
    setOpenChild(id)
    // 子对话在右栏开：会话栏放不下时让给右栏（窄屏右栏是抽屉，开着子对话就拉出来，见 aside 的 childOn）
    if (id) setLastRail('files')
    if (!pane) writePaneChild(taskId, id)
  }
  // 消息里「新建子对话」「交给子对话」那一行点开右栏的子对话；引用保持不变，消息行不用跟着重画
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const openChildRow = useCallback((id: string) => openChildIn(id), [taskId, pane])
  // 父对话里点子对话结果卡片的标题：同样在右栏打开它，再让它滚到自己的详细总结（见 jumpSummary）
  const [childSummaryAt, setChildSummaryAt] = useState(0)
  const openChildSummary = useCallback(
    (id: string) => {
      openChildIn(id)
      setChildSummaryAt(Date.now())
    },
    // 和 openChildRow 一样只按对话换：引用不变，回复里的卡片不用跟着重画
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [taskId, pane],
  )
  const openRunIn = (run: number) => {
    // 子对话自己的面板没有再分一栏：就地换成那次运行的视图，返回后还是这个子对话
    if (pane) {
      setPaneRun(run ? { run } : null)
      return
    }
    setOpenRun(run)
    if (run) setOnParent(false)
    writePaneRun(taskId, run)
  }
  // 子对话面板里点「启动工作流」这一行：认回它启动的是第几次运行，就地打开那次运行的视图
  const openPaneRun = (tool: ToolUse) => setPaneRun({ run: task ? (startedRun(task, tool) ?? 0) : 0, tool })

  // 记着的子对话已经不在这个父对话下了（被删掉）：回退到文件面板并清掉这条记录
  // 名下工作流运行也在右栏打开（和运行区的工作流卡片共用一份列表）：它们不在子对话列表里，不能当成被删掉
  const ownedIds = useOwnedRuns(!pane && task && !task.parentTaskId ? task.id : '').map((x) => x.id)
  const ownedKey = ownedIds.join(',')
  useEffect(() => {
    if (!openChild || !children.length) return
    if (children.some((x) => x.id === openChild) || ownedKey.split(',').includes(openChild)) return
    setOpenChild('')
    writePaneChild(taskId, '')
  }, [children, openChild, taskId, ownedKey])

  // 出了新的报告（重新分析、接着追问后又出了一份）：收起过的面板重新打开
  const seenReport = useRef(c.reportId)
  useEffect(() => {
    const prev = seenReport.current
    seenReport.current = c.reportId
    if (!c.reportId || !prev || c.reportId === prev) return
    foldReport(false)
    // 只跟着报告换了没有走
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [c.reportId])

  return {
    openChild,
    onParent,
    setOnParent,
    filesFolded,
    toggleFiles,
    sessionOpen,
    setSessionOpen,
    lastRail,
    setLastRail,
    reportFolded,
    foldReport,
    reportCover,
    setReportCover,
    openRun,
    paneRun,
    setPaneRun,
    chatRailOn,
    toggleChatRail,
    openChildIn,
    openChildRow,
    childSummaryAt,
    openChildSummary,
    openRunIn,
    openPaneRun,
    ownedIds,
  }
}
