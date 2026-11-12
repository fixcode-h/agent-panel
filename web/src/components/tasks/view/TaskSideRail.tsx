/**
 * 对话页右边那一栏：项目文件和本对话改动（或 AI 分析的功能面板），子对话在这一栏开页签；
 * Chat 页（没有项目的聊天）换成代码、来源、附件那一栏；窄屏时是抽屉，后面垫一层遮罩。
 * 从 TaskView.tsx 拆出来（重构文档第 13 条）：开合和宽度状态由 TaskView 管，这里只画
 */
import { X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TaskStep } from '@shared/schema'
import type { TaskPage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize'
import { ChatRail, type useChatRail } from '../ChatRail'
import type { ChildSummary } from '../child-line'
import type { DiagnosisRail } from '../diagnosis-window'
import { TaskFiles } from '../TaskFiles'
import { REPORT_COVER_WIDTH, type useHalfPane } from '../task-view-pane'

type Pane = ReturnType<typeof useHalfPane>

export interface TaskSideRailProps {
  task: TaskPage
  embed: boolean
  projectPath?: string
  /** 窄屏从标题栏点了「文件」：抽屉开着 */
  panel: boolean
  closePanel: () => void
  /** 功能面板（分析报告等）：宽屏并排占这一栏，或盖在对话上（reportCover） */
  reportOn: boolean
  reportCover: boolean
  closeReportCover: () => void
  reportTitle?: string
  reportPanel: React.ReactNode
  reportPane: Pane
  taskPanel: Pane
  railRef: (el: HTMLElement | null) => void
  filesHidden: boolean
  noFiles: boolean
  node?: TaskStep
  /** 诊断报告停靠在右栏时的那一块（useDiagnosisHost 的 rail） */
  report: DiagnosisRail | null
  childOn: boolean
  openChild: string
  kids: ChildSummary[]
  /** 名下工作流运行的 id：它们也在这里开，但标题写「工作流运行」 */
  ownedIds: string[]
  childSummaryAt: number
  closeChild: () => void
  /** 右栏里那个子对话自己的对话页（TaskView 传进来，免得两个文件互相引用） */
  childView: React.ReactNode
  chatRailShown: boolean
  chatRail: ReturnType<typeof useChatRail>
  openLocalFile: (path: string) => void
  apply: (t: TaskPage) => void
  pane?: boolean
}

export function TaskSideRail(p: TaskSideRailProps) {
  const { task, panel, reportOn, reportCover, childOn } = p
  return (
    <>
      {/* Chat 页的右栏：代码、来源、附件（聊天没有项目文件）。宽屏并排，窄屏不占位置 */}
      {p.chatRailShown && (
        <aside
          aria-label={t('聊天右栏')}
          data-chat-rail
          className="panel relative hidden w-[min(420px,40%)] shrink-0 flex-col overflow-hidden xl:flex"
        >
          <ChatRail rail={p.chatRail} taskId={task.id} onOpenFile={p.openLocalFile} />
        </aside>
      )}
      {/* 右栏：项目文件和本对话改动（或 AI 分析的功能面板）。子对话在这一栏开页签（TaskFiles 的 child），运行在中间开页签。
      外面不滚动，拖动条才不会被 overflow 裁掉 */}
      {!p.pane && (
        <aside
          ref={p.railRef}
          aria-label={!panel && (reportOn || reportCover) && p.reportTitle ? p.reportTitle : t('文件')}
          data-task-panel
          style={{
            // 功能面板：覆盖态（窄屏从标题栏打开、pane 里）没有并排可拖，按定宽封顶在容器内；
            // 宽屏并排时用拖过的宽度（记在这台机器上，刷新后保持），没拖过就是和对话对半
            width:
              !panel && reportCover
                ? `min(${REPORT_COVER_WIDTH}px, 100%)`
                : !panel && reportOn
                  ? p.reportPane.width
                  : p.taskPanel.width,
          }}
          className={cn(
            'relative shrink-0 flex-col',
            p.embed ? 'border-l bg-rail' : 'panel',
            // 窄屏右栏是抽屉：点了文件按钮、盖着功能面板、或开着子对话（子对话在右栏的页签里）时拉出来
            // 手机宽度下子对话抽屉占满整屏：拖过的栏宽在手机上只剩两百多像素，输入框和行都挤成一团（U9）
            panel || reportCover || childOn
              ? cn('fixed inset-y-0 right-0 z-40 flex max-w-full shadow-pop', childOn && 'max-md:w-full!')
              : 'hidden',
            // 宽屏固定在这一栏上：拖动条 absolute 定位在左边缘，位置不能是 static，否则会跑到外层容器上去
            'xl:relative xl:z-auto xl:flex xl:h-full xl:shadow-none',
            (p.filesHidden || (p.noFiles && !childOn)) && !reportOn && !reportCover && 'xl:hidden',
          )}
        >
          {/* 功能面板占右栏（宽屏并排）时也能拖，和文件面板一样记在本机；
          窄屏和 pane 里是盖在对话上的抽屉（reportCover），没有并排可拖，那时不挂拖动条 */}
          {!panel && reportOn && !reportCover && (
            <ResizeHandle pane={p.reportPane} label={t('拖动调整功能面板的宽度')} className="hidden xl:block" />
          )}
          {!panel && !reportOn && !reportCover && (
            <ResizeHandle pane={p.taskPanel} label={t('拖动调整文件面板的宽度')} className="hidden xl:block" />
          )}
          {panel && (
            <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 xl:hidden">
              <span className="text-body font-semibold">{t('文件')}</span>
              <Button autoFocus variant="ghost" size="icon-sm" aria-label={t('关闭面板')} onClick={p.closePanel}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {!panel && (reportOn || reportCover) && p.reportPanel ? (
            p.reportPanel
          ) : (
            <TaskFiles
              task={task}
              dir={p.projectPath}
              node={p.node}
              onTask={p.apply}
              report={p.report}
              child={
                childOn
                  ? {
                      id: p.openChild,
                      task: p.kids.find((c) => c.id === p.openChild),
                      label: p.ownedIds.includes(p.openChild) ? t('工作流运行') : undefined,
                      onClose: p.closeChild,
                      focus: p.childSummaryAt,
                      // 切到别的页签时不卸载，回来滚动位置、输入框里的字都还在
                      view: p.childView,
                    }
                  : undefined
              }
            />
          )}
        </aside>
      )}
      {(panel || reportCover || childOn) && (
        <div
          className="fixed inset-0 z-30 bg-black/40 xl:hidden"
          onClick={() => (reportCover ? p.closeReportCover() : panel ? p.closePanel() : p.closeChild())}
        />
      )}
    </>
  )
}
