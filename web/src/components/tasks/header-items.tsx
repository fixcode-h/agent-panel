import type { Dispatch, ReactNode, SetStateAction } from 'react'
import {
  Activity,
  CircleStop,
  ClipboardList,
  Copy,
  Cpu,
  Download,
  FileCode2,
  History,
  ListPlus,
  PanelRight,
  Pencil,
  PictureInPicture2,
  RotateCw,
  Settings2,
  Sparkles,
  SquareChartGantt,
  Trash2,
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { IconButton, ToggleIconButton } from '@/components/ui/icon-button'
import type { HeaderItem } from './HeaderPins'
import { ProcessMenu } from './ProcessPanel'

/**
 * 对话页标题栏按钮和「更多操作」菜单的清单（钉没钉由 HeaderPins 管）。
 * 从 TaskView 拆出来只是为了文件不超长：状态和开关都还在对话页，这里只按它们拼出每一项。
 * 顺序就是菜单里的顺序，也是钉在标题栏时从左到右的顺序
 */
export type HeaderItemsCtx = {
  task: Task
  pane?: boolean
  /** 有父对话或子对话，才有「父子往来记录」 */
  family: boolean
  /** AI 分析对话的功能面板标题；不是分析对话时没有 */
  reportTitle?: string
  reportOn: boolean
  reportCover: boolean
  setReportCover: Dispatch<SetStateAction<boolean>>
  filesHidden: boolean
  /** 项目对话的文件栏 / Chat 页的右栏 / 都没有 */
  rail: 'files' | 'chat' | null
  chatRailEmpty: boolean
  chatRailShown: boolean
  /** 会话栏有没有开关：连中间对话都放不下时不给 */
  sessionToggle: boolean
  sessionShown: boolean
  /** 有任务进度可看（工作流） */
  progress: boolean
  progressOpen: boolean
  setProgressOpen: Dispatch<SetStateAction<boolean>>
  procOpen: boolean
  setProcOpen: (v: boolean) => void
  /** 正在处理这一轮：这时不能 AI 分析 */
  busy: boolean
  /** 工作流改过、停下了：可以按最新的工作流继续 */
  resumeLatest: boolean
  /**
   * 能不能转成弹窗：只在对话页本体上给——右栏子对话（pane）、AI 窗口里嵌的（embed）不需要，
   * 右栏本来就在对话旁边、AI 窗口自己已经有最小化按钮；导入的任务只能看，不收。
   * 子对话也不给：浮条的状态和标题靠 useData().tasks 找对话，而 /tasks 列表
   * 只回顶层对话（见 server/tasks.ts），子对话收起来会一出现就写「对话已关闭」
   */
  canPopout: boolean
  on: {
    settings: () => void
    rename: () => void
    exportIt: () => void
    exportHtml: () => void
    copy: () => void
    status: () => void
    collab: () => void
    analyze: () => void
    forceStop: () => void
    resumeLatest: () => void
    remove: () => void
    popout: () => void
    session: (v: boolean) => void
    reportWide: () => void
    filesWide: () => void
    filesCover: () => void
    chatRail: () => void
  }
}

/** 宽屏（xl）才有并排的右栏：没钉在标题栏、从菜单里开关文件栏和功能面板时按它分宽屏 / 窄屏两种做法 */
const wide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 80rem)').matches

/**
 * 返回菜单 / 标题栏的清单，外加右栏开关（railButton）：右栏开关不进菜单、不能取下，
 * 固定在「更多操作」右边、标题栏的最右端（用户要求）
 */
export function taskHeaderItems(c: HeaderItemsCtx): { items: HeaderItem[]; railButton: ReactNode } {
  const { task, pane, on } = c
  const items: HeaderItem[] = []
  // 项目里的父对话有自己的设置：目标、全局规则、子对话
  if (task.projectId && !task.parentTaskId && task.mode === 'chat' && !task.imported)
    items.push({ key: 'settings', icon: Settings2, label: t('对话设置'), onSelect: on.settings })
  items.push(
    { key: 'rename', icon: Pencil, label: t('重命名'), onSelect: on.rename },
    {
      key: 'export',
      icon: Download,
      label: t('导出任务'),
      title: t('连同它分出的子对话一起导出，导入后父子结构能还原'),
      onSelect: on.exportIt,
    },
    {
      key: 'exportHtml',
      icon: FileCode2,
      label: t('导出 HTML 报告'),
      title: t('导出一个自包含的 HTML 文件，没装面板的浏览器也能直接打开'),
      onSelect: on.exportHtml,
    },
    { key: 'copy', icon: Copy, label: t('复制对话'), onSelect: on.copy },
    { key: 'status', icon: Activity, label: t('状态'), onSelect: on.status },
  )
  if (c.family) items.push({ key: 'collab', icon: History, label: t('父子往来记录'), onSelect: on.collab })
  items.push(
    {
      key: 'processes',
      icon: Cpu,
      label: t('对话进程'),
      // 等菜单收起再打开：同一下点击还在菜单上，马上打开会被当成点在下拉外面又关掉
      onSelect: () => window.setTimeout(() => c.setProcOpen(true), 0),
      pinned: <ProcessMenu taskId={task.id} open={c.procOpen} onOpenChange={c.setProcOpen} />,
    },
    // CLI 还连着、只是在等下一句时也能分析：只有真的在处理这一轮才不行
    { key: 'analyze', icon: Sparkles, label: t('AI 分析执行结果'), disabled: c.busy, onSelect: on.analyze },
  )
  // 停止只收这一轮，CLI 还留着等下一句；要连进程一起结束时用这一项
  if (!task.imported) items.push({ key: 'forceStop', icon: CircleStop, label: t('强制停止'), onSelect: on.forceStop })
  if (c.resumeLatest)
    items.push({ key: 'resumeLatest', icon: RotateCw, label: t('按最新的工作流继续'), onSelect: on.resumeLatest })
  items.push({ key: 'delete', icon: Trash2, label: t('删除任务'), danger: true, onSelect: on.remove })

  // 下面是原来常驻标题栏的开关：默认钉着（转成弹窗除外），取下后在菜单里照样能用
  if (c.progress)
    items.push({
      key: 'progress',
      icon: ListPlus,
      label: t('任务进度'),
      onSelect: () => c.setProgressOpen((v) => !v),
      pinned: (
        <IconButton
          size="sm"
          tone="bare"
          icon={ListPlus}
          label={t('任务进度')}
          aria-expanded={c.progressOpen}
          onClick={() => c.setProgressOpen((v) => !v)}
        />
      ),
    })
  // 转成弹窗：把当前对话收成右下角的浮条，页面回到上一级。用得少，默认不钉
  if (c.canPopout)
    items.push({
      key: 'popout',
      icon: PictureInPicture2,
      label: t('转成弹窗'),
      title: t('转成弹窗（对话继续在后台运行）'),
      onSelect: on.popout,
    })
  // AI 分析对话的功能面板：宽屏切到右栏（子对话、运行开着时先收起它们），窄屏和子对话面板里盖在对话上
  const report = c.reportTitle
  if (report)
    items.push({
      key: 'report',
      icon: ClipboardList,
      label: report,
      onSelect: () => (!pane && wide() ? on.reportWide() : c.setReportCover((v) => !v)),
      pinned: (
        <>
          {!pane && (
            <ToggleIconButton
              size="sm"
              icon={ClipboardList}
              className="hidden xl:grid"
              label={report}
              title={c.reportOn ? t('收起功能面板') : report}
              pressed={c.reportOn}
              onPressedChange={on.reportWide}
            />
          )}
          <ToggleIconButton
            size="sm"
            icon={ClipboardList}
            className={pane ? undefined : 'xl:hidden'}
            label={report}
            pressed={c.reportCover}
            onPressedChange={c.setReportCover}
          />
        </>
      ),
    })
  // 会话栏：中间对话右边的一列（环境、上下文、状态、用量）
  if (c.sessionToggle) {
    const label = c.sessionShown ? t('隐藏会话栏') : t('显示会话栏')
    items.push({
      key: 'session',
      icon: SquareChartGantt,
      label,
      onSelect: () => on.session(!c.sessionShown),
      pinned: (
        <ToggleIconButton
          size="sm"
          icon={SquareChartGantt}
          label={label}
          pressed={c.sessionShown}
          onPressedChange={on.session}
        />
      ),
    })
  }
  // 右栏开关：项目对话是文件栏（窄屏从右边滑出来盖在对话上），Chat 页是代码 / 来源 / 附件
  let railButton: ReactNode = null
  if (c.rail === 'files') {
    const open = !c.filesHidden && !c.reportOn
    railButton = (
      <>
        <IconButton
          size="sm"
          tone="bare"
          icon={PanelRight}
          label={t('显示文件')}
          title={t('文件')}
          onClick={on.filesCover}
          className="xl:hidden"
        />
        <IconButton
          size="sm"
          tone="bare"
          className="hidden xl:grid"
          // 收起时和窄屏那个按钮一样：读屏名是「显示文件」、悬停提示「文件」（两者都指同一栏）
          label={open ? t('收起文件面板') : t('显示文件')}
          title={open ? t('收起文件面板') : t('文件')}
          aria-expanded={open}
          onClick={on.filesWide}
        >
          {/* 开着、收起同一个图标（设计稿）：开着时图标是前景色（tone="bare" 按 aria-expanded 提亮） */}
          <PanelRight className="h-4 w-4" />
        </IconButton>
      </>
    )
  } else if (c.rail === 'chat') {
    railButton = (
      <ToggleIconButton
        size="sm"
        // 设计稿：标题栏右端的图标都无底，开着时是前景色
        tone="bare"
        icon={PanelRight}
        label={t('开关右栏')}
        // 三样都没有时禁用，悬停说明为什么点不了
        title={
          c.chatRailEmpty ? t('这段聊天里还没有代码、来源或附件') : c.chatRailShown ? t('收起右栏') : t('打开右栏')
        }
        pressed={c.chatRailShown}
        disabled={c.chatRailEmpty}
        onPressedChange={on.chatRail}
        // 右栏只在宽屏并排（窄屏放不下第二栏），开关跟着只在宽屏出现
        className="hidden xl:grid"
      />
    )
  }
  return { items, railButton }
}
