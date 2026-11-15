import { Suspense, lazy, useContext, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@shared/i18n'
import { useDiagDialogs } from './diag-dialogs'
import { useDiagnosisHost } from './diagnosis-window'
import { useHeaderPins } from './HeaderPins'
import { taskHeaderItems } from './header-items'
import { TurnRail } from './TurnRail'
import { chatHelperIds } from './HelperCards'
import { liveWaitText } from '@shared/live/task-live'
import type { Project } from '@shared/schema'
import { blockedStep, flowUnfinished, taskFlow, taskWorkflows, topSteps } from '@shared/flow'
import { childWait } from '@shared/task'
import { withTaskModel } from '@shared/tasks/run'
import { agentRun, defaultCli, defaultSettings } from '@shared/settings'
import { getCli, steerable } from '@shared/clis'
import { api } from '@/lib/api'
import { minimizeTask, minimizeBackRoute } from '@/lib/mini-task'
import { useEscape } from '@/lib/useEscape'
import { WithAgents, useData, useNav, useTasks } from '@/lib/data'
import { withImportedAgents } from '@shared/tasks/export'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConversationShell } from '@/components/chat/ConversationShell'
import { AnalysisPanel, useTaskReport } from './AnalysisPanel'
import { AnalysisMark } from './AnalysisMark'
import { isAnalysisTask } from '@/lib/analysis-report'
import { LoadTrace } from './LoadTrace'
import { RunPanel } from './RunCard'
import { RunView } from './RunView'
import { TaskPanel } from './TaskPanel'
import { EnvChip } from './TaskMeta'
import { SessionBar } from '@/components/session/SessionBar'
import { ConversationTabs } from './ConversationTabs'
import { useChatRail } from './ChatRail'
import { FileOpenCtx } from './FileDialog'
import { HandleNeedsCtx, SummaryCardsCtx } from './Markdown'
import { AiLookCtx } from '@/lib/ai-look'
import { ChildListCtx, ChildMailProvider, PaneNavCtx, PaneToolbarCtx } from './child-open'
import { asksQuestion } from './RequestCard'
import { DropOverlay } from '@/components/chat/Attachments'
import { canStartFlow } from '@shared/flow/run'
import { FileRefLayer } from '@/components/files/FileRefLayer'
import { useTaskTabs } from '@/plugins/registry'
// 栏宽和本地记忆、子对话列表、已读和在场、摘要节流、导出：按功能拆在这几个文件，这里只调用
import { NO_MESSAGES, RAIL_GUTTER, SESSION_BAR_W, WEB_RAIL_MIN } from './task-view-pane'
import { useChildList, useChildPolling, usePeerLetters } from './task-view-children'
import { taskExportActions } from './task-view-actions'
// 对话页按区域拆开的部分（重构文档第 13 条、复查报告 B2）：数据、动作、开合状态、输入框、滚动、分段、栏宽是 hook，
// 标题区、消息流、输入框、停靠区、右栏、弹窗是组件；这里只做布局，把 hook 的结果传下去
import { useTaskLoad } from './view/use-task-load'
import { useHandleNeeds, useTaskActions } from './view/use-task-actions'
import { useTaskPanes } from './view/use-task-panes'
import { useTaskComposer } from './view/use-task-composer'
import { stepJumper, useTaskScroll } from './view/use-task-scroll'
import { useBlockLimit, useTaskBlocks } from './view/use-task-blocks'
import { useTaskRail } from './view/use-task-rail'
import { useTaskDialogs } from './view/use-task-dialogs'
import { useTaskToggles } from './view/use-task-toggles'
import { useTurnAnnounce } from './view/use-turn-announce'
import { railLayout } from './view/rail-layout'
import { railToggles } from './view/rail-toggles'
import { ChatHeader, HeaderActions, HeaderBadges, HeaderNav, TaskTitle } from './view/TaskHeader'
import { TaskMessages } from './view/TaskMessages'
import { ReplyStatus } from './view/ReplyStatus'
import { FollowComposer, flowHint } from './view/FollowComposer'
import { ConversationDock } from './view/ConversationDock'
import { TaskSideRail } from './view/TaskSideRail'
import { WebHostCtx, useWebTabFocus, useWebTabs } from '@/lib/web-view/tabs'
import { TaskDialogs } from './view/TaskDialogs'
import { RouteProvider } from './route-context'

/** 流程图视图用到的画布库比较大，切到流程图时才加载 */
const TaskFlow = lazy(() => import('./TaskFlow').then((m) => ({ default: m.TaskFlow })))

/** 一个任务的对话页：上方是执行输出，下方继续输入要求，右侧是进度、上下文和更改 */
/** project 为空时是 Chat 模式的聊天，不属于任何项目 */

export function TaskView({
  taskId,
  project,
  embed,
  pane,
  onClose,
  jumpSummary,
}: {
  taskId: string
  project?: Project
  /** 放在弹窗里（例如「AI 处理」）：标题栏右边加上弹窗自己的按钮；要跳到别的页面时先收起弹窗 */
  embed?: {
    actions: React.ReactNode
    onLeave: () => void
    /**
     * 弹窗标题栏里留给对话操作的位置（AI 分析窗口）：给了就不画对话自己的页签行（标题和弹窗标题栏重复），
     * 状态和操作按钮挂到这里；中间开着子对话、运行页签时仍画页签行，要靠它切回来
     */
    slot?: HTMLElement | null
  }
  /** 放在对话页右侧的子对话栏里：不画自己的右栏，标题栏加上关闭按钮 */
  pane?: boolean
  onClose?: () => void
  /** 子对话面板：父对话里点了它的结果卡片（时间戳），打开后滚到最后一份总结 */
  jumpSummary?: number
}) {
  const { agents: localAgents, workflows, settings, upsertTask, removeTask, projects: allProjects } = useData()
  const { tasks } = useTasks()
  const nav = useNav()
  const go: typeof nav.go = (r) => {
    embed?.onLeave()
    nav.go(r)
  }
  // 很长的任务先只画最后一部分（view/use-task-blocks.ts）
  const { limit, setLimit } = useBlockLimit(taskId)
  // 对话数据：打开时取一份、建 SSE、往前翻页、已读和在场、加载日志（view/use-task-load.ts）
  const load = useTaskLoad({
    taskId,
    jumpMsg: nav.route.msg,
    tasks,
    upsertTask,
    onOlder: () => setLimit(Infinity),
  })
  const { task, setTask, apply, live, running, trace } = load
  // 导入的任务：本机没有的 Agent 用导入时带来的，名字照常显示
  const imported = task?.imported
  const agents = useMemo(() => withImportedAgents(localAgents, { imported }), [localAgents, imported])
  // 对话页顶层的弹窗（view/TaskDialogs.tsx）：开关都在这一份里，标题栏菜单、消息菜单、文件路径都往这里写
  const { dialogs, setDialog, openFile, openJob } = useTaskDialogs()
  // 对话菜单「状态」（CLI 生命周期诊断）和「父子往来记录」（ADR 0034：默认不在右栏）
  const diag = useDiagDialogs(taskId)
  // 标题栏按钮和「更多操作」菜单是同一份清单，钉上的显示在标题栏（所有对话共用，见 HeaderPins）
  const pins = useHeaderPins()
  // 文件面板浮层、任务进度浮层、「对话进程」下拉的开关和 Esc（view/use-task-toggles.ts）
  const { procOpen, setProcOpen, panel, setPanel, progressOpen, setProgressOpen } = useTaskToggles()
  // 子对话列表的状态和拉取（task-view-children.ts）
  const childList = useChildList()
  const { children, setChildren, loadChildren } = childList
  // 分析报告在哪条回复里：画在右侧的功能面板，不再铺在对话区（用户 2026-10-25 要求，ADR 0016）
  const report = useTaskReport(task)
  // 右栏开着哪个子对话、哪次运行，各个面板收没收（view/use-task-panes.ts）
  const panes = useTaskPanes({ taskId, pane, task, childList, reportId: report?.message.id ?? '' })
  const { openChild, openRun, paneRun, reportCover, setReportCover, openChildIn } = panes
  // 右栏打开的是子对话时，它在自己的 Provider 里读不到父对话的列表和跳转：
  // 这里在组件顶层取外层的值（Provider 之外），标题旁的切换下拉用它，不另取一份数据
  const outerChildren = useContext(ChildListCtx)
  const outerNav = useContext(PaneNavCtx)
  // 右栏页签条右端的工具区（ADR 0047）：给了就不画子对话自己的标题栏，按钮挂到那里
  const toolbarSlot = useContext(PaneToolbarCtx)
  const inToolbar = pane && !!toolbarSlot
  // 父对话和名下子对话之间的信（task-view-children.ts）
  const peerMail = usePeerLetters(task?.messages, task?.inbox)
  // 这一行和右栏的尺寸（view/use-task-rail.ts）
  const { rowW, setRowEl, setRail, taskPanel, reportPane } = useTaskRail(!!embed)
  // 网页页签（设计稿第 6 节）：新开了网页就展开右栏（窄屏拉出抽屉），右栏太窄时放宽一些（不写本机，拖过的宽度照旧）。
  // 放在父对话右栏里的子对话（pane）没有自己的右栏，网页开到父对话那边
  useWebTabFocus(pane ? '' : taskId, () => {
    if (panes.filesFolded) panes.toggleFiles()
    panes.setLastRail('files')
    if (taskPanel.width < WEB_RAIL_MIN) taskPanel.fit(WEB_RAIL_MIN)
    if (!matchMedia('(min-width: 80rem)').matches) setPanel(true)
  })
  const webTabCount = useWebTabs(pane ? '' : taskId).tabs.length
  // Chat 页（没有项目的聊天）的右栏：从对话里抽出的代码、来源、附件，都没有时右栏开关禁用
  const chatRail = useChatRail(task?.messages ?? NO_MESSAGES)
  // 诊断报告的审阅弹窗同理：一轮输出完、子任务做完时打开它的那一行会重挂，弹窗只由用户关
  // 顶层对话页有并排的右栏：报告能停靠进去（分析稿 U7），右栏里的子对话、AI 窗口里嵌的只弹窗
  const bug = useDiagnosisHost(task, !pane && !embed)
  // CLI 真的在处理这一轮才算执行中；等下一句时页面按空闲显示
  const working = task?.working ?? false
  // 盖着文件面板时 Esc 先收面板，不弹停止确认
  useEscape(!!task?.working && !panel && !dialogs.stopAsk && !openRun && !paneRun, () => setDialog('stopAsk', true))
  // 视图（对话 / 流程图）、贴底滚动、悬浮层留白、滚到总结（view/use-task-scroll.ts）
  const scroll = useTaskScroll({ taskId, jumpSummary, loadedId: task?.id, messageCount: task?.messages.length })
  const { scroller, view, setView, flowSel, setFlowSel, focus, openFlow } = scroll
  const stickToBottom = scroller.pin
  // 工作流运行在右栏打开时先看流程图：用这块面板自己（页签条上）的「对话 / 流程图」切，
  // 不再盖一层带「输出 / 流程图」的运行视图，两排切换重复（用户 2026-11-15 要求只留上面那排）。每个运行只自动切一回
  const flowShown = useRef('')
  useEffect(() => {
    if (!pane || !task?.flowRun || flowShown.current === task.id) return
    flowShown.current = task.id
    setView('flow')
    // 只看对话换了没有、是不是工作流运行：task 每次推送都是新对象
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, task?.id, !!task?.flowRun])
  // 输入框：草稿、附件、@ 引用、拖文件、消息引用、「/」菜单（view/use-task-composer.ts）
  const composerState = useTaskComposer({
    taskId,
    task,
    project,
    allProjects,
    agents,
    settings,
    running,
    apply,
    stickToBottom,
  })
  const { draftEmpty, taRef: followTa, files, mention, dropArea, dropOver, slash } = composerState

  // 子对话列表：首拉、轮询、推送信号（task-view-children.ts）
  useChildPolling(task, trace, childList)

  // 读屏用的状态播报（view/use-turn-announce.ts）
  const announce = useTurnAnnounce(working, task?.status === 'failed')

  // 任务创建时存下的工作流；现在的版本改过时，可以选择按新的继续
  const workflow = task ? taskWorkflows(task, workflows).workflow : undefined
  const latestWf = workflows.find((w) => w.id === task?.workflowId)
  const wfChanged = !!task?.workflows.length && !!latestWf && latestWf.updatedAt !== workflow?.updatedAt
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  // 对话里派出的子任务：输入框上方的「子任务」栏里列出，点开看它的实时对话流；一个都没有时不画这条栏
  const helperIds = useMemo(() => (task ? chatHelperIds(task) : []), [task])
  // 点了就调接口的动作和它们自己的进行中状态（view/use-task-actions.ts）
  const act = useTaskActions({
    taskId,
    task,
    project,
    workflows,
    working,
    apply,
    setTask,
    lastTask: load.lastTask,
    files,
    taRef: followTa,
    slash,
    stickToBottom,
    upsertTask,
    removeTask,
    go,
    loadChildren,
    setChildren,
    closeDelete: () => setDialog('deleting', false),
  })
  // 总结卡「要你处理」的「处理」按钮（view/use-task-actions.ts）
  const handleNeeds = useHandleNeeds(act.say)
  useEscape(reportCover, () => setReportCover(false), true)

  // 消息流要画的段：待认领、分段、限长、最新一轮和正在输出的一轮（view/use-task-blocks.ts）
  const { blocks, hidden, latestTurn, liveTurn, shownBlocks, jumpToTurn } = useTaskBlocks({
    task,
    pendingMsgs: act.pendingMsgs,
    working,
    limit,
    setLimit,
  })

  // 插件给这个对话的右栏页签（ADR 0059）：放在提前返回之前，hook 每次渲染都要调到
  const pluginTabs = useTaskTabs(task ?? undefined)
  if (!task)
    return (
      <main className={cn('flex flex-1 items-center justify-center text-subtle', !pane && !embed && 'panel')}>
        <LoadTrace steps={trace.steps} />
      </main>
    )

  const pluginHome = pluginTabs.some((x) => x.home)
  // Chat 模式的聊天不属于项目：没有可看的项目文件，右边的文件栏和展开按钮都不显示。
  // 插件页签标了 home 的对话（例如模型设计的 3D 预览，不属于项目）照样要右栏放那个页签
  // 开着网页页签的聊天同样要右栏放它
  const noFiles = !task.projectId && !pluginHome && !webTabCount
  // Chat 页的聊天换成自己的标题栏和右栏（Chat.dc.html）；项目里的对话照旧用页签条。
  // 聊天派出了子对话或开着运行页签时也退回页签条，那些页签要有地方放
  const chatPage = noFiles && !pane && !embed && task.mode === 'chat' && !children.length && !openRun
  // 这一轮没在跑时到底在等什么：等后台命令、等子任务、等工作流，还是真停在等下一句。
  // 统一用 shared/task 的 childWait（子对话栏、交给父对话的上报用的是同一个），不在这里另写一套
  // 「有没有东西在跑」——以前只看 awaitingUser，子任务还在跑也写「等待你的下一条消息」
  const chatWait =
    task.mode === 'chat' && live
      ? childWait(task, { background: live.jobs.length, cliAlive: live.cliAlive })
      : undefined
  // 子对话在右栏开一个页签（和项目文件、本对话改动并排），开着时右栏一定显示
  const childOn = !pane && !!openChild
  // 功能面板占右栏（宽屏）：和文件面板同一栏，同一时间只显示一个；开着子对话时先让给子对话
  const reportOn = !!report && !pane && !panes.reportFolded && !childOn && !bug.rail
  // 中间正显示运行页签（父对话藏起来）
  const showOther = !pane && !panes.onParent && openRun > 0
  // Chat 页（不属于项目）也有会话栏，只是不显示环境那些和项目有关的块（见 SessionBar 的 noProject）
  const sessionAllowed = !pane && !embed && !showOther
  // Chat 页的右栏（代码、来源、附件）：和项目对话的文件栏一样参与「并排放不放得下」
  const chatRailWanted = chatPage && panes.chatRailOn && !chatRail.empty && !reportOn && !reportCover
  const { sessionFits, sessionShown, filesYield, chatRailShown, filesHidden } = railLayout({
    rowW,
    sessionAllowed,
    sessionOpen: panes.sessionOpen,
    chatRailWanted,
    reportOn,
    reportW: reportPane.width,
    taskPanelW: taskPanel.width,
    childOn,
    bugRail: !!bug.rail,
    filesFolded: panes.filesFolded,
    noFiles,
    lastRail: panes.lastRail,
    pluginHome,
  })
  const closeReport = () => {
    if (reportCover) return setReportCover(false)
    panes.foldReport(true)
  }
  const reportPanel = report && (
    <AnalysisPanel task={task} project={project} report={report} onTask={apply} onClose={closeReport} />
  )

  // 执行中也能发：相关的要求会调整当前方向，交不出去的等这一轮结束后接着处理
  // 引入工作流只给项目里的父对话、而且角色能启动工作流（start_workflow 只给这样的父对话）；子对话不启动工作流
  const canPickFlow =
    !!task.projectId && !task.parentTaskId && task.mode !== 'workflow' && canStartFlow(localAgents, task.agentId)
  // 主流程的节点（不含主 Agent）；「都做完了」要连主 Agent 的整理一起算
  const tops = topSteps(task)
  const roots = task.steps.filter((s) => !s.parentId)
  const runningSteps = task.steps.filter((s) => s.status === 'running')
  const chatAgent = agents.find((a) => a.id === task.agentId)
  // 对话实际用的 CLI；Codex、Claude Code 能在执行中插话，Command Code 这类靠面板的工具取
  const chatCli = chatAgent
    ? agentRun(withTaskModel(chatAgent, task), settings ?? defaultSettings()).cli
    : task.mode === 'chat'
      ? // 不用角色的对话：服务端按对话自己选的 CLI 跑，没选按会话所在的 CLI，都没有才用默认 CLI（见 withTaskModel）
        task.cli || task.sessionCli || defaultCli(settings ?? defaultSettings())
      : ''
  // 工作流的节点收不了补充时，服务端会留给下一个节点，所以工作流总能补充
  const canSteer = working && (task.mode === 'workflow' || steerable(chatCli))
  // 不用角色的对话按 CLI 显示：署名是 CLI、模型和思考强度，输入框里随时能换
  const byCli = task.mode === 'chat' && !task.agentId
  const chatRun = { cli: task.cli || task.sessionCli || '', model: task.model, effort: task.effort }
  const chatLabel = (byCli ? getCli(chatCli)?.name : chatAgent?.name) || t('无角色')
  const mainAgent = agents.find((a) => a.id === workflow?.mainAgentId)
  const isFlow = task.mode === 'workflow' && view === 'flow'
  const flowNode = isFlow ? task.steps.find((s) => s.id === flowSel) : undefined
  // 点了任务进度里的某一步：切到流程图并定位到那一步（view/use-task-scroll.ts）
  const openStep =
    task.mode === 'workflow' ? stepJumper({ scroll, hidden, setLimit, closePanel: () => setPanel(false) }) : undefined
  // 运行区那行「工作流」：工作流对话里和卡片一样切到流程图，普通对话（计划触发的运行）没有流程图，仍打开那次运行
  const runNav =
    task.mode === 'workflow' ? { runView: () => openFlow(), runTip: t('在流程图里查看') } : { runView: panes.openRunIn }
  // 工作流没走完时输入框上面有「继续流程」，输入框里就不再放「继续执行」
  const flowLeft = task.mode === 'workflow' && !running && flowUnfinished(task, workflow)
  const blocked = task.mode === 'workflow' ? blockedStep(task, taskFlow(task, workflow)) : undefined
  const failed = task.status === 'failed'
  const canResume = (failed || task.status === 'stopped') && draftEmpty && !flowLeft
  // 这一轮已说完、名下还有东西在跑（子对话 / 子任务 / 后台命令 / 工作流）：输入框只说「继续输入要求」
  // 会和旁边的停止按钮自相矛盾——用户看到的是「子对话在跑，父对话却停在等继续」。
  // 让它说清到底在等什么
  const waitText = !working ? liveWaitText(live) : ''
  const workflowName = task.mode === 'workflow' ? (workflow?.name ?? t('已删除的工作流')) : undefined

  // 导出、复制对话（task-view-actions.ts）
  const exports = taskExportActions(task)

  // 右边看某一次运行的实时输出时，输入框跟着挪到那个面板底下，不用关掉再看对话
  // 子对话请用户选择：和 Agent 的提问一样换掉输入框（Agent 自己的提问优先）
  const askOpen = (task.child?.parentAsks ?? []).length > 0 && !task.imported && !asksQuestion(task.requests)
  // AI 分析窗口里嵌的分析对话：左侧对话区照设计稿 AiWindow 画（见 lib/ai-look.ts），普通对话页不受影响
  const aiLook = !!embed && isAnalysisTask(task, localAgents)
  // 已收尾（已解决）的子对话不给输入框：换成「已收尾 + 重新打开」一行，点了才重新出现输入框（用户 2026-10-31）
  const closedChild = !!task.parentTaskId && !!task.resolved && !task.imported
  const allDone = roots.every((s) => s.status === 'done')
  const composer = !task.imported && !closedChild && !asksQuestion(task.requests) && !askOpen && (
    <FollowComposer
      task={task}
      live={live}
      taskId={taskId}
      aiLook={aiLook}
      working={working}
      sending={act.sending}
      resuming={act.resuming}
      canSteer={canSteer}
      // 还在等名下的东西跑完时不放「继续执行」：再拉起一遍会和还在跑的子对话重复。只挡「已停止」：失败时「重试」要能点；
      // 用户亲手停的（user）也不挡：整棵树已经停了，服务端继续时会先等它们停稳（settleBefore），挡了就找不到继续入口
      showResume={!working && !(task.status === 'stopped' && waitText && task.stopReason !== 'user') && canResume}
      failed={failed}
      canPickFlow={canPickFlow}
      canMention={!!project?.path || (!task.projectId && allProjects.some((p) => p.path))}
      waitText={waitText}
      dropScope={isFlow ? null : dropArea}
      node={flowNode}
      files={files}
      mention={mention}
      slash={slash}
      taRef={followTa}
      byCli={byCli}
      chatRun={chatRun}
      chatAgent={chatAgent}
      flowHint={
        task.mode === 'workflow'
          ? flowHint({
              busy: working,
              failed,
              blocked,
              running: tops.filter((s) => s.status === 'running').length,
              allDone,
              mainName: mainAgent?.name ?? '',
            })
          : undefined
      }
      resumeTitle={task.mode === 'workflow' && !allDone ? t('从没完成的节点继续执行') : t('重新执行最后一条要求')}
      onEmptyChange={composerState.setDraftEmpty}
      onDropOver={composerState.setDropOver}
      send={act.send}
      stop={act.stop}
      resume={() => act.resume()}
      changeRun={act.changeRun}
      setTask={setTask}
      apply={apply}
    />
  )

  // 对话页的停靠区：计划、子对话、提醒和输入框（view/ConversationDock.tsx）
  const conversationDock = (
    <ConversationDock
      task={task}
      pane={pane}
      traceSteps={load.traceHidden ? trace.steps : undefined}
      kids={children}
      helperIds={helperIds}
      teamNames={teamNames}
      openChild={openChild}
      onOpenChild={openChildIn}
      onResumeChild={(id) => void act.resumeChild(id)}
      onAnswerChild={act.answerChild}
      onFloatHeight={scroll.setFloatPad}
      composer={composer}
      composerElsewhere={(showOther && !!openRun) || !!paneRun}
      askOpen={askOpen}
      closedChild={closedChild}
      flowLeft={flowLeft}
      blocked={blocked}
      resuming={act.resuming}
      onResume={() => act.resume()}
      onAnalyze={() => setDialog('analyzing', true)}
      projectName={project?.name}
      projectPath={project?.path}
      workflowName={workflowName}
      node={flowNode}
      inRail={sessionShown}
      apply={apply}
    />
  )

  // 标题区（面包屑、状态、标题）和操作按钮：父对话放进页签条（标题是父对话页签、按钮在页签条右端），
  // 中间打开的子对话沿用原来的标题栏（view/TaskHeader.tsx）
  const titleNode = <TaskTitle task={task} live={live} localAgents={localAgents} name={act.name} />
  // 标题栏的按钮和「更多操作」菜单是同一份清单（header-items、HeaderPins）：钉上的画在「更多操作」左边，没钉的只在菜单里
  const { items: headerItems, railButton } = taskHeaderItems({
    task,
    pane,
    family: !!task.parentTaskId || children.length > 0,
    reportTitle: report ? report.title : undefined,
    reportOn,
    reportCover,
    setReportCover,
    filesHidden,
    rail: !pane && !noFiles ? 'files' : chatPage ? 'chat' : null,
    chatRailEmpty: chatRail.empty,
    chatRailShown,
    sessionToggle: sessionAllowed && sessionFits,
    sessionShown,
    progress: task.mode === 'workflow' && tops.length > 0,
    progressOpen,
    setProgressOpen,
    procOpen,
    setProcOpen,
    busy: running && working,
    resumeLatest: !task.imported && wfChanged && (task.status === 'failed' || task.status === 'stopped'),
    canPopout: !pane && !embed && !task.imported && !task.parentTaskId,
    on: {
      settings: () => setDialog('convSettings', true),
      rename: () => act.name.setRenaming(task.title),
      exportIt: exports.exportIt,
      exportHtml: exports.exportHtml,
      copy: exports.copyIt,
      status: diag.openStatus,
      collab: diag.openCollab,
      analyze: () => setDialog('analyzing', true),
      forceStop: () => setDialog('forceAsk', true),
      resumeLatest: () => void act.resume(true),
      remove: () => setDialog('deleting', true),
      popout: () => {
        minimizeTask({ id: task.id, projectId: task.projectId || undefined })
        // 和 AI 窗口的“去对话里看”相反：收起后回上一级，不同时显示对话页和浮条
        go(minimizeBackRoute({ projectId: task.projectId || undefined }))
      },
      // 会话栏、功能面板、文件面板、Chat 右栏的开关（view/rail-toggles.ts）
      ...railToggles({ panes, filesYield, chatRailWanted, chatRailShown, reportOn, closeReport }),
      filesCover: () => setPanel(true),
    },
  })
  const headerActions = (
    <HeaderActions
      task={task}
      pane={pane}
      inToolbar={!!inToolbar}
      view={view}
      onView={scroll.switchView}
      resolving={act.resolving}
      onResolve={() => void act.resolveChild()}
      items={headerItems}
      isPinned={pins.isPinned}
      setPinned={pins.setPinned}
      procOpen={procOpen}
      setProcOpen={setProcOpen}
      railButton={railButton}
      extra={embed?.actions}
    />
  )
  const badgesAndActions = (
    <>
      <HeaderBadges task={task} />
      {headerActions}
    </>
  )
  // 一轮回复里的「答复」类按钮、教训弹窗交给角色整理：不碰输入框直接发一句
  const say = act.say

  return (
    <WithAgents agents={agents}>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
      <TaskViewCtx
        taskId={task.id}
        projectId={task.projectId}
        openFile={openFile}
        aiLook={aiLook}
        handleNeeds={task.imported ? null : handleNeeds}
        cards={!task.parentTaskId}
        web={{ taskId: pane ? (task.parentTaskId ?? task.id) : task.id, projectId: task.projectId }}
      >
        {/* 子对话（右栏面板或单独打开）里点「启动工作流」：就地换成这次运行的视图，下面带着输入框 */}
        <PaneNavCtx.Provider
          value={
            pane || task.parentTaskId
              ? { runTool: panes.openPaneRun, ...runNav, ...bug.nav, openChild, job: openJob }
              : {
                  child: panes.openChildRow,
                  childSummary: panes.openChildSummary,
                  ...runNav,
                  ...bug.nav,
                  openChild,
                  job: openJob,
                }
          }
        >
          <ChildMailProvider kids={children} mail={peerMail}>
            <div
              ref={setRowEl}
              className={cn(
                'relative flex min-w-0 flex-1',
                pane ? 'h-full min-h-0' : 'min-h-[70vh] md:h-full md:min-h-0',
              )}
            >
              <main
                ref={composerState.setDropArea}
                className={cn('relative flex min-w-0 flex-1 flex-col bg-bg md:h-full', !pane && !embed && 'panel')}
              >
                {/* 打开对话的加载日志：数据到了先盖在对话上，走完停一会儿再淡出（不挡下面的对话） */}
                {!load.traceHidden && <LoadTrace overlay steps={trace.steps} onHidden={load.hideTrace} />}
                {/* 从外面把文件拖到对话页任何位置都算引入到要求里；右栏和流程图有自己的拖拽语义，不在范围内 */}
                {dropOver && <DropOverlay />}
                {chatPage ? (
                  <ChatHeader
                    task={task}
                    live={live}
                    scrolled={scroll.scrolled}
                    title={titleNode}
                    roleLabel={byCli ? undefined : chatLabel}
                    exports={exports}
                    actions={headerActions}
                  />
                ) : inToolbar ? (
                  // 右栏里的子对话（ADR 0047）：状态和标题在页签上，按钮挂到页签条右端的工具区，不再画一行标题栏
                  createPortal(badgesAndActions, toolbarSlot!)
                ) : pane ? (
                  <header
                    className={cn(
                      // group/hdr：标题栏右侧的「解决」按钮默认隐起来，鼠标进到标题栏或 Tab 聚焦时才显示
                      'group/hdr flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-colors md:px-5',
                      scroll.scrolled ? 'border-line' : 'border-transparent',
                    )}
                  >
                    <HeaderNav
                      task={task}
                      live={live}
                      pane={pane}
                      outerChildren={outerChildren}
                      outerNav={outerNav}
                      title={titleNode}
                    />
                    {headerActions}
                  </header>
                ) : embed?.slot && !showOther ? (
                  createPortal(badgesAndActions, embed.slot)
                ) : (
                  <ConversationTabs
                    task={task}
                    runName={task.workflowName || workflow?.name}
                    openRun={openRun}
                    front={showOther ? 'other' : 'parent'}
                    renaming={act.name.renaming}
                    onRenaming={act.name.setRenaming}
                    onRename={act.name.rename}
                    onParent={() => panes.setOnParent(true)}
                    onOther={() => panes.setOnParent(false)}
                    onCloseRun={() => panes.openRunIn(0)}
                    mark={isAnalysisTask(task, localAgents) ? <AnalysisMark kind={task.analysis?.kind} /> : undefined}
                    trailing={badgesAndActions}
                  />
                )}

                {/* 父对话本身：中间换成子对话或运行页签时只是藏起来，切回来滚动位置、输入框里的字都还在 */}
                {/* data-scroll-pair：对话正文和会话栏的滚动条共用右边一条槽，鼠标在哪块显示哪块的（见 RailScrollbar） */}
                <div data-scroll-pair className={cn('relative flex min-h-0 flex-1', showOther && 'hidden')}>
                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    <ConversationShell
                      scroller={scroller}
                      floatPad={scroll.floatPad}
                      overlay={
                        <>
                          {progressOpen && (
                            <div className="absolute top-3 left-3 z-20 w-[min(340px,calc(100%-1.5rem))] md:left-4">
                              <TaskPanel task={task} onStep={openStep} className="shadow-pop" />
                            </div>
                          )}
                          {/* 右上角的轮次导航：没有会话栏时让出滚动条（12px），有会话栏时贴着会话栏左边 */}
                          {!isFlow && (
                            <TurnRail
                              msgs={task.messages}
                              scrollEl={scroller.el}
                              onJump={jumpToTurn}
                              right={sessionShown ? SESSION_BAR_W + RAIL_GUTTER + 4 : 14}
                            />
                          )}
                        </>
                      }
                      // 流程图视图自己管滚动：上面的流程图固定，只有下面的节点输出滚动
                      fill={
                        isFlow ? (
                          <Suspense fallback={null}>
                            <TaskFlow
                              task={task}
                              focus={focus}
                              onSelect={setFlowSel}
                              onOpenChat={() => {
                                setView('chat')
                              }}
                            />
                          </Suspense>
                        ) : undefined
                      }
                      onScroll={(e) => scroll.setScrolled(e.currentTarget.scrollTop > 4)}
                      // 段落（用户消息、一轮回复）之间 20px（设计稿 16–20px），比默认的 28px 紧凑
                      contentClassName="gap-5"
                      dock={conversationDock}
                      // 会话栏浮在右边（下面的 aside）：消息和输入框让出它的宽度，滚动条留在最右边
                      rail={sessionShown ? SESSION_BAR_W + RAIL_GUTTER : 0}
                    >
                      {(hidden > 0 || task.messageHasMore) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={load.earlierLoading}
                          onClick={() => (task.messageHasMore ? void load.loadEarlier() : setLimit(Infinity))}
                          className="self-center rounded-full text-xs font-normal text-muted"
                        >
                          {task.messageHasMore ? t('显示更早的消息') : t('显示更早的 {n} 段', { n: hidden })}
                        </Button>
                      )}
                      <RouteProvider
                        task={task}
                        send={async (text) => apply(await api.sendMessage(task.id, text, [], false))}
                      >
                        <TaskMessages
                          ctx={{
                            task,
                            shown: shownBlocks,
                            hidden,
                            total: blocks.length,
                            latestTurn,
                            liveTurn,
                            working,
                            running,
                            teamNames,
                            fallback: byCli ? chatRun : undefined,
                            firstUser: task.messages.find((m) => m.role === 'user')?.id,
                            localAgents,
                            hasProject: !!project,
                            workflowName: workflow?.name,
                            apply,
                            stickToBottom,
                            resend: act.resend,
                            fork: act.fork,
                            onRewind: (id) => setDialog('rewindAsk', id),
                            onLesson: (text) => setDialog('lessonOf', text),
                            openRun: panes.openRunIn,
                            openFlow,
                          }}
                        />
                      </RouteProvider>
                      <ReplyStatus
                        task={task}
                        running={running}
                        working={working}
                        lastIsTurn={blocks.at(-1)?.kind === 'turn'}
                        chatLabel={chatLabel}
                        fallback={byCli ? chatRun : undefined}
                        chatWait={chatWait}
                        awaiting={task.awaitingUser}
                        noRunningSteps={runningSteps.length === 0}
                        mainName={mainAgent?.name}
                        onStatus={diag.openStatus}
                      />
                      {/* CLI 还没取走的消息已经直接进对话，这里不用再放一份 */}
                    </ConversationShell>
                  </div>
                  {/* 会话栏在对话右边、同一块面板里（照 Claude Code），不占右侧的文件栏。
                      固定浮在右边、不跟着消息滚：消息区的滚动容器铺满到最右，滚动条在它右边那一条（RAIL_GUTTER）里 */}
                  {sessionShown && (
                    <aside
                      aria-label={t('会话栏')}
                      data-session-rail
                      style={{ width: SESSION_BAR_W, right: RAIL_GUTTER }}
                      // 和对话之间一道细线分开（照 Claude Code 的功能区），不再是浮着的圆角卡片
                      className="absolute inset-y-0 z-10 flex flex-col border-l border-line bg-bg"
                    >
                      <SessionBar
                        task={task}
                        projectName={project?.name}
                        onTask={apply}
                        kids={children}
                        noProject={noFiles}
                        railGutter={RAIL_GUTTER}
                        env={
                          <EnvChip
                            compact
                            task={task}
                            projectName={project?.name}
                            projectPath={project?.path}
                            workflowName={workflowName}
                            onOpenChild={openChildIn}
                          />
                        }
                        onSettings={
                          task.projectId && !task.parentTaskId && task.mode === 'chat' && !task.imported
                            ? () => setDialog('convSettings', true)
                            : undefined
                        }
                      />
                    </aside>
                  )}
                </div>
                {/* 中间的运行页签：这一次工作流运行的节点和实时输出，底下带着输入框 */}
                {!pane && showOther && openRun > 0 && (
                  <RunPanel
                    task={task}
                    run={openRun}
                    name={task.workflowName || workflow?.name}
                    onClose={() => panes.openRunIn(0)}
                    footer={composer}
                  />
                )}
                {/* 子对话里点开的一次运行：盖在这块面板上，子对话本身不卸载，返回后滚动位置原样保留。
                    返回（←）回子对话这一层，✕ 走 onClose 关掉子对话面板本身。
                    输入框跟着放在运行视图底下，和父对话右栏的运行面板一样，看着节点也能补充要求 */}
                {/* 子对话面板里没有地方并排：功能面板盖在对话上，收起后对话原样回来 */}
                {pane && reportCover && reportPanel && (
                  <div className="absolute inset-0 z-30 flex flex-col">{reportPanel}</div>
                )}
                {paneRun && (
                  <RunView
                    task={task}
                    run={paneRun.run}
                    tool={paneRun.tool}
                    tab={paneRun.tab}
                    onBack={() => panes.setPaneRun(null)}
                    onClose={onClose}
                    footer={composer}
                  />
                )}
              </main>

              <TaskSideRail
                task={task}
                pane={pane}
                embed={!!embed}
                projectPath={project?.path}
                panel={panel}
                closePanel={() => setPanel(false)}
                reportOn={reportOn}
                reportCover={reportCover}
                closeReportCover={() => setReportCover(false)}
                reportTitle={report ? report.title : undefined}
                reportPanel={reportPanel}
                reportPane={reportPane}
                taskPanel={taskPanel}
                railRef={setRail}
                filesHidden={filesHidden}
                noFiles={noFiles}
                node={flowNode}
                report={bug.rail}
                childOn={childOn}
                openChild={openChild}
                kids={children}
                ownedIds={panes.ownedIds}
                ownedRows={panes.ownedRows}
                childSummaryAt={panes.childSummaryAt}
                closeChild={() => openChildIn('')}
                childView={
                  childOn && (
                    <TaskView
                      key={openChild}
                      taskId={openChild}
                      project={project}
                      pane
                      onClose={() => openChildIn('')}
                      jumpSummary={panes.childSummaryAt}
                    />
                  )
                }
                chatRailShown={chatRailShown}
                chatRail={chatRail}
                openLocalFile={(path) => setDialog('fileTarget', { path, local: true })}
                apply={apply}
              />
            </div>
            <TaskDialogs
              task={task}
              project={project}
              localAgents={localAgents}
              working={working}
              state={dialogs}
              set={setDialog}
              stop={act.stop}
              forceStop={act.forceStop}
              remove={act.remove}
              // 对话里的角色知道刚才哪里做错了，交给它整理
              askAgent={(message) => say(message)}
              onRewound={(r) => {
                apply(r.task)
                followTa.current?.setText(r.text)
                // 那条消息的图片、文件、引用一起放回来：卡片已经在文字里
                files.replace(r.attachments ?? [])
                followTa.current?.focus()
              }}
              apply={apply}
              more={
                <>
                  {bug.dialog}
                  {diag.dialogs(task.parentTaskId ? outerNav?.child : openChildIn)}
                </>
              }
            />
          </ChildMailProvider>
        </PaneNavCtx.Provider>
      </TaskViewCtx>
    </WithAgents>
  )
}

/**
 * 对话页往下传的两个上下文：点文件路径打开文件窗口、AI 分析窗口的样式（lib/ai-look.ts）。
 * 合成一个组件是为了不在 TaskView 的大段 JSX 外面再套一层（套一层整段都要重新缩进）
 */
function TaskViewCtx({
  taskId,
  projectId,
  openFile,
  aiLook,
  handleNeeds,
  cards,
  web,
  children,
}: {
  taskId: string
  projectId?: string
  openFile: (path: string, line?: number) => void
  aiLook: boolean
  handleNeeds: ((text: string) => Promise<void>) | null
  /** 子对话里总结照普通 Markdown 显示，不画卡片（见 Markdown 的 SummaryCardsCtx） */
  cards: boolean
  /** 回复里的网页开到哪个对话的右栏（lib/web-view/tabs.ts） */
  web: { taskId: string; projectId?: string }
  children: React.ReactNode
}) {
  return (
    <WebHostCtx.Provider value={web}>
      <FileOpenCtx.Provider value={openFile}>
        <FileRefLayer taskId={taskId} projectId={projectId} preview={openFile}>
          <AiLookCtx.Provider value={aiLook}>
            <HandleNeedsCtx.Provider value={handleNeeds}>
              <SummaryCardsCtx.Provider value={cards}>{children}</SummaryCardsCtx.Provider>
            </HandleNeedsCtx.Provider>
          </AiLookCtx.Provider>
        </FileRefLayer>
      </FileOpenCtx.Provider>
    </WebHostCtx.Provider>
  )
}
