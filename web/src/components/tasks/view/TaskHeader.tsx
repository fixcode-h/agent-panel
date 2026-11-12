/**
 * 对话页的标题区：标记（模拟 / 导入）、标题（双击改名）、面包屑和标题栏按钮，Chat 页自己的标题栏。
 * 从 TaskView.tsx 拆出来（重构文档第 13 条）：开关状态仍由 TaskView 管，这里只按 props 画
 */
import {
  CheckCircle2,
  Download,
  FileCode2,
  FileInput,
  FileText,
  FlaskConical,
  GitBranch,
  MessageSquareText,
  MoreHorizontal,
  Upload,
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { Agent } from '@shared/schema'
import { liveBusy, type TaskLive } from '@shared/live/task-live'
import { taskWord } from '@shared/tasks/word'
import type { TaskPage } from '@/lib/api'
import { isAnalysisTask } from '@/lib/analysis-report'
import type { ChildSummary } from '../child-line'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { IconButton } from '@/components/ui/icon-button'
import { InlineRename } from '@/components/ui/inline-rename'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { StatusPill } from '@/components/ui/status-pill'
import { AnalysisMark } from '../AnalysisMark'
import { ChildSwitcher } from '../ChildSwitcher'
import { cliAliveHint, cliTreeAlive } from '../CliAlive'
import { HandoffButton } from '../HandoffButton'
import { PinMenuRow, PinnedButton, type HeaderItem } from '../HeaderPins'
import { ProcessMenu } from '../ProcessPanel'
import { TaskStatusIcon } from '../TaskStatusIcon'
import type { PaneNav } from '../child-open'

/** 模拟 / 导入标记：子对话在标题后面，父对话在页签条右端（对话进程是标题栏按钮，可钉，见 headerItems） */
export function HeaderBadges({ task }: { task: TaskPage }) {
  return (
    <>
      {task.simulated && (
        <Badge tone="warning" title={t('没有真正调用 Agent，输出是示例')} className="hidden shrink-0 md:inline-flex">
          <FlaskConical className="h-3 w-3" />
          {/* 右栏工具区里只留图标，悬停看说明（ADR 0047） */}
          <span className="@max-[600px]:sr-only">{t('模拟')}</span>
        </Badge>
      )}
      {task.imported && (
        <Badge tone="accent" title={t('从导出的文件导入，只能查看')} className="hidden shrink-0 md:inline-flex">
          <FileInput className="h-3 w-3" />
          {/* 右栏工具区里只留图标，悬停看说明（ADR 0047） */}
          <span className="@max-[600px]:sr-only">{t('导入')}</span>
        </Badge>
      )}
    </>
  )
}

/** 改名：renaming 只记「正在改、从哪个标题开始改」，输入框交回最终的值 */
export interface RenameState {
  renaming: string | null
  setRenaming: (v: string | null) => void
  rename: (value: string) => Promise<void>
}

/** 标题（双击改名）：对话页签条里、子对话面板的标题栏、Chat 页的标题栏共用 */
export function TaskTitle({
  task,
  live,
  localAgents,
  name,
}: {
  task: TaskPage
  live?: TaskLive
  localAgents: Agent[]
  name: RenameState
}) {
  if (name.renaming !== null)
    return (
      <InlineRename
        value={name.renaming}
        label={t('任务标题')}
        onCommit={name.rename}
        onCancel={() => name.setRenaming(null)}
        className="flex-1 font-medium"
      />
    )
  return (
    <>
      {isAnalysisTask(task, localAgents) && <AnalysisMark kind={task.analysis} className="ml-1" />}
      {/* 对话（或名下子对话）有活着的 CLI：标题上流过一道高光，CLI 关了就没有 */}
      <h2
        title={[live ? cliAliveHint(live) : '', t('双击重命名')].filter(Boolean).join(' · ')}
        onDoubleClick={() => name.setRenaming(task.title)}
        className={cn('min-w-0 truncate px-1 font-medium', !!live && cliTreeAlive(live) && 'cli-alive-title')}
      >
        {task.title}
      </h2>
    </>
  )
}

/** 标题前的状态：和侧栏、项目首页同一个判定（taskState） */
function StatusIcon({ task, live, className }: { task: TaskPage; live?: TaskLive; className: string }) {
  return (
    <TaskStatusIcon
      status={task.status}
      working={liveBusy(live)}
      spin={liveBusy(live)}
      waiting={live?.state === 'needs'}
      label={taskWord(task).word}
      className={className}
    />
  )
}

/**
 * 子对话面板标题栏左边：切换下拉、状态、标题、标记。
 * outer* 是父对话那一层的子对话列表和跳转：TaskView 在自己的 Provider 之外取好传进来，这里不能自己 useContext
 */
export function HeaderNav({
  task,
  live,
  pane,
  outerChildren,
  outerNav,
  title,
}: {
  task: TaskPage
  live?: TaskLive
  pane?: boolean
  outerChildren: ChildSummary[]
  outerNav: PaneNav | null
  title: React.ReactNode
}) {
  return (
    <nav aria-label={t('位置')} className="flex min-w-0 flex-1 items-center gap-1 text-body">
      {/* 右栏打开子对话：标题左边给一个下拉，和消息流里的入口一样列出父对话的全部子对话，
          点一项就地切换；列表中用外层（父对话）的那份数据，当前这一项带勾选 */}
      {pane && task.parentTaskId && outerNav?.child && (
        <ChildSwitcher list={outerChildren} current={task.id} onOpen={(id) => outerNav?.child?.(id)} className="ml-1" />
      )}
      {/* 标题前的状态和侧栏、项目首页同一个判定（taskState）：自己在跑、在等子对话 / 子任务 /
          后台命令 / 工作流都转圈，有没回复的提问、请求换成提问图标 */}
      <StatusIcon task={task} live={live} className="ml-1" />
      {title}
      <HeaderBadges task={task} />
    </nav>
  )
}

export interface HeaderActionsProps {
  task: TaskPage
  pane?: boolean
  /** 右栏页签条右端的工具区（ADR 0047）：窄了把钉住的按钮收起来 */
  inToolbar: boolean
  view: 'chat' | 'flow'
  onView: (v: 'chat' | 'flow') => void
  resolving: boolean
  onResolve: () => void
  items: HeaderItem[]
  isPinned: (key: HeaderItem['key']) => boolean
  setPinned: (key: HeaderItem['key'], v: boolean) => void
  procOpen: boolean
  setProcOpen: (v: boolean) => void
  railButton: React.ReactNode
  extra?: React.ReactNode
}

/** 标题栏的按钮和「更多操作」菜单是同一份清单（header-items、HeaderPins）：钉上的画在「更多操作」左边，没钉的只在菜单里 */
export function HeaderActions(p: HeaderActionsProps) {
  const { task, pane, view } = p
  const pinnedItems = p.items.filter((x) => p.isPinned(x.key))
  return (
    <>
      {task.mode === 'workflow' && (
        // 样子同 Segmented（seg-track / seg-thumb），但窄屏只留图标，Segmented 没有这种响应式写法，先手写
        <div className="seg-track flex shrink-0 rounded-lg p-0.5" role="tablist" aria-label={t('视图')}>
          {(
            [
              ['chat', t('对话'), MessageSquareText],
              ['flow', t('流程图'), GitBranch],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              role="tab"
              aria-label={label}
              aria-selected={view === v}
              onClick={() => p.onView(v)}
              className={cn(
                'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium',
                view === v ? 'seg-thumb' : 'text-muted hover:text-fg',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', v === 'flow' && 'rotate-90')} />
              <span className="hidden sm:inline @max-[560px]:hidden!">{label}</span>
            </button>
          ))}
        </div>
      )}
      {/* 子对话面板右上角的「解决」：标记为已解决，记录、分支和未提交改动都保留；已经解决时换成标记 */}
      {pane &&
        task.parentTaskId &&
        (task.resolved ? (
          <StatusPill tone="ok" title={t('已解决')}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            {/* 右栏工具区窄了先把文字收掉，只留对勾（ADR 0047 的收缩顺序第一步） */}
            <span className="@max-[600px]:sr-only">{t('已解决')}</span>
          </StatusPill>
        ) : (
          <IconButton
            size="sm"
            tone="bare"
            label={t('解决')}
            disabled={p.resolving}
            onClick={p.onResolve}
            // 默认隐起来（opacity-0），鼠标进标题栏（右栏是页签条）或焦点进来才显示；
            // 没有 hover 的设备（触屏、平板）常显，否则根本点不到
            className="opacity-0 group-focus-within/hdr:opacity-100 group-hover/hdr:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <CheckCircle2 className="h-4 w-4" />
          </IconButton>
        ))}
      {pinnedItems.map((x) =>
        // 右栏工具区窄了把钉住的按钮收起来（它们都还在「更多操作」里）；对话进程的面板要贴着它弹出，不收
        p.inToolbar && x.key !== 'processes' ? (
          <span key={x.key} className="flex @max-[520px]:hidden!">
            <PinnedButton item={x} />
          </span>
        ) : (
          <PinnedButton key={x.key} item={x} />
        ),
      )}
      {/* 对话进程没钉在标题栏时：从菜单打开，面板贴着「更多操作」左边这个看不见的锚点弹出 */}
      {!p.isPinned('processes') && (
        <ProcessMenu taskId={task.id} open={p.procOpen} onOpenChange={p.setProcOpen} hidden />
      )}
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="sm" tone="bare" label={t('更多操作')}>
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
        </MenuTrigger>
        <MenuContent className="min-w-[220px]">
          {p.items.map((x) => (
            <PinMenuRow key={x.key} item={x} pinned={p.isPinned(x.key)} onPin={(v) => p.setPinned(x.key, v)} />
          ))}
        </MenuContent>
      </Menu>
      {/* 右栏开关不进菜单，固定在「更多操作」右边 */}
      {p.railButton}
      {p.extra}
    </>
  )
}

/** Chat 页（没有项目的聊天）的标题栏（Chat.dc.html）：标题，右边导出、开关右栏 */
export function ChatHeader({
  task,
  live,
  scrolled,
  title,
  roleLabel,
  exports,
  actions,
}: {
  task: TaskPage
  live?: TaskLive
  scrolled: boolean
  title: React.ReactNode
  /** 用了角色的对话写一下是谁在回答；不用角色的不传 */
  roleLabel?: string
  exports: { exportIt: () => unknown; exportHtml: () => unknown; exportMd: () => unknown }
  actions: React.ReactNode
}) {
  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-1.5 border-b px-3 transition-colors md:pl-4',
        scrolled ? 'border-line' : 'border-transparent',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 text-prose [&_h2]:font-semibold">
        <StatusIcon task={task} live={live} className="shrink-0" />
        {title}
        <HeaderBadges task={task} />
      </div>
      {/* 用了角色的写一下是谁在回答；Agent 和模型的选择都在输入框里，不放标题栏 */}
      {roleLabel !== undefined && <span className="min-w-0 truncate px-2 text-xs text-subtle">{roleLabel}</span>}
      {!task.imported && <HandoffButton taskId={task.id} />}
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="sm" tone="bare" label={t('导出')}>
            <Upload className="h-4 w-4" />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={exports.exportHtml} title={t('导出一个自包含的 HTML 文件，没装面板的浏览器也能直接打开')}>
            <FileCode2 className="h-4 w-4" />
            {t('导出 HTML 报告')}
          </MenuItem>
          <MenuItem onSelect={exports.exportMd} title={t('导出成一份 Markdown，方便贴进文档或笔记')}>
            <FileText className="h-4 w-4" />
            {t('导出 Markdown')}
          </MenuItem>
          <MenuItem onSelect={exports.exportIt} title={t('连同它分出的子对话一起导出，导入后父子结构能还原')}>
            <Download className="h-4 w-4" />
            {t('导出任务')}
          </MenuItem>
        </MenuContent>
      </Menu>
      {actions}
    </header>
  )
}
