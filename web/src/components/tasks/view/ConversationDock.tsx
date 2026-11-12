/**
 * 对话页的停靠区：计划和子对话贴在输入框上方、在消息流外面，不跟着滚，也不插在用户消息和回复之间。
 * 固定三行（见 ChildrenBar）：计划在上、子任务中间、子对话在下，每行各自不换行，三行都和输入框左对齐。
 * 从 TaskView.tsx 拆出来（重构文档第 13 条）
 */
import { isChatMode } from '@shared/conv-mode'
import type { TaskStep } from '@shared/schema'
import type { TaskPage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FloatAbove } from '@/components/chat/FloatAbove'
import type { TraceStep } from '@/lib/load-trace'
import { ParentAskPanel } from '../ChildAskCard'
import { ParentBar } from '../ChildMail'
import { ChildrenBar, plainRow } from '../ChildrenBar'
import type { ChildSummary } from '../child-line'
import { ImportedBar, ResolvedBar } from '../InputBars'
import { LoadTracePill } from '../LoadTrace'
import { PlanButton } from '../PlanPanel'
import { TaskRequestCard, asksQuestion } from '../RequestCard'
import { SharedDirNotice } from '../SharedDirNotice'
import { TaskMeta } from '../TaskMeta'
import { FlowBar, WorktreeBar } from '../TaskViewParts'
import { TodoButton } from '../TodoButton'
import { UserActionPanel } from '../UserActionPanel'

export interface ConversationDockProps {
  task: TaskPage
  pane?: boolean
  /** 加载日志收起后还在跑的后台步骤：留一个小胶囊 */
  traceSteps?: TraceStep[]
  kids: ChildSummary[]
  helperIds: string[]
  teamNames: Set<string>
  openChild: string
  onOpenChild: (id: string) => void
  onResumeChild: (id: string) => void
  onAnswerChild: (childId: string, rid: string, allow: boolean) => Promise<void>
  onFloatHeight: (h: number) => void
  /** 输入框（没有时是 false：导入的、已收尾的、在提问的） */
  composer: React.ReactNode
  /** 输入框挪进了运行面板 / 子对话里就地打开的运行，这里先空着 */
  composerElsewhere: boolean
  askOpen: boolean
  closedChild: boolean
  flowLeft: boolean
  blocked?: TaskStep
  resuming: boolean
  onResume: () => void
  onAnalyze: () => void
  projectName?: string
  projectPath?: string
  workflowName?: string
  node?: TaskStep
  inRail: boolean
  apply: (t: TaskPage) => void
}

export function ConversationDock(p: ConversationDockProps) {
  const { task, apply, composer } = p
  // 子对话入口只在父对话里显示（右栏和子对话自己的页面不列子对话）；
  // 子任务入口哪里都显示：它派在哪个对话里，就在哪里看
  const showChildren = !p.pane && !task.parentTaskId && p.kids.length > 0
  const helpers = p.helperIds.length ? { task, ids: p.helperIds, teamNames: p.teamNames } : undefined
  return (
    <>
      {/* 面板收起后还在跑的后台步骤（实时更新、子对话列表）：留一个小胶囊，失败时写错误原文 */}
      {p.traceSteps && <LoadTracePill steps={p.traceSteps} />}
      {task.plans?.length > 0 && (
        <div className="shrink-0 px-3 md:px-6">
          {/* 宽度跟着内容走：计划这一行通常就一小段字，撑满会在右边留下一片空框 */}
          <div className="mx-auto max-w-(--content-w)">
            <div data-status-row="plan" className={cn(plainRow, 'mb-1 w-fit max-w-full flex-nowrap')}>
              <PlanButton task={task} kids={p.kids} />
            </div>
          </div>
        </div>
      )}
      {/* Chat 模式没有面板计划，用 CLI 自带的待办（ADR 0038）：同一个位置显示 */}
      {isChatMode(task) && !task.plans?.length && task.todos?.length > 0 && (
        <div className="shrink-0 px-3 md:px-6">
          <div className="mx-auto max-w-(--content-w)">
            <div data-status-row="todos" className={cn(plainRow, 'mb-1 w-fit max-w-full flex-nowrap')}>
              <TodoButton task={task} />
            </div>
          </div>
        </div>
      )}
      {/* 子对话这一侧：父对话交代的任务原文和最新回答（ADR 0034，原来规划在右栏的「父对话」卡放到这里） */}
      {task.parentTaskId && (
        <div className="shrink-0 px-3 md:px-6">
          <ParentBar task={task} className="mx-auto mb-1 max-w-(--content-w)" />
        </div>
      )}
      {(showChildren || helpers) && (
        <ChildrenBar
          kids={showChildren ? p.kids : []}
          helpers={helpers}
          openChild={p.openChild}
          onOpen={p.onOpenChild}
          onClose={() => p.onOpenChild('')}
          onResume={p.onResumeChild}
          onAnswer={p.onAnswerChild}
        />
      )}
      <div className="relative shrink-0 px-3 pt-1 pb-3 md:px-6 md:pb-5">
        {/* 等你确认、等你操作、流程没走完这些提醒紧贴着输入框上方悬浮（用户 2026-11-10）：不把输入框往下顶、
            也不挤掉消息区；盖住上面的计划、子对话那几行没关系，不要浮到消息区里去。越往下越要紧，
            自己这个对话要你点头的请求离输入框最近。子对话的请求不在这里弹，留在子对话栏那一行 */}
        <FloatAbove onHeight={p.onFloatHeight}>
          {composer && <SharedDirNotice task={task} onChange={apply} />}
          {p.flowLeft && !task.imported && (
            <FlowBar task={task} blocked={p.blocked} resuming={p.resuming} onResume={p.onResume} onChange={apply} />
          )}
          {composer && <UserActionPanel task={task} onChanged={apply} />}
          {!asksQuestion(task.requests) && (
            <TaskRequestCard task={task} onAnswered={apply} className="w-full shadow-pop" />
          )}
        </FloatAbove>
        {/* 提问照旧换掉输入框，不浮 */}
        {asksQuestion(task.requests) && <TaskRequestCard task={task} onAnswered={apply} />}
        {p.askOpen && <ParentAskPanel task={task} onClosed={apply} />}
        <WorktreeBar task={task} />
        {task.imported && <ImportedBar task={task} onAnalyze={p.onAnalyze} />}
        {p.closedChild && <ResolvedBar taskId={task.id} onTask={apply} />}
        {/* 点开运行面板、子对话里就地打开运行时输入框挪进去，这里先空着，避免出现两个输入框 */}
        {!p.composerElsewhere && composer}
        {/* 上下文、Token 用量和环境放在输入框下面，右栏留给文件系统 */}
        <TaskMeta
          task={task}
          projectName={p.projectName}
          projectPath={p.projectPath}
          workflowName={p.workflowName}
          node={p.node}
          // 有输入框时上下文圆环在输入框工具条里（设计稿），这里不重复
          hideContext={!!composer}
          inRail={p.inRail}
          onTask={apply}
          // 子对话自己的面板里不再套一层右栏
          onOpenChild={p.pane ? undefined : p.onOpenChild}
        />
      </div>
    </>
  )
}
