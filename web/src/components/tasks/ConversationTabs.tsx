import type { ReactNode } from 'react'
import { MessageSquareText, Workflow as WorkflowIcon } from 'lucide-react'
import type { Task } from '@shared/schema'
import { childIcon, taskBusy, taskState, taskWaitText } from '@shared/task'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { cliAliveHint, cliTreeAlive } from './CliAlive'
import type { ChildSummary } from './child-line'
import { TaskStatusIcon } from './TaskStatusIcon'

/**
 * 对话页顶上的页签条（照 Proma）：父对话一个页签，不能关；旁边是中间打开的子对话或这次工作流运行，
 * 同一时间只开一个、能关。标题栏原来的按钮放在页签条右端（trailing）。
 * 页签的状态图标和侧栏同一处判定：父对话走 taskState，子对话走 childIcon
 */
export function ConversationTabs({
  task,
  child,
  runName,
  openChild,
  openRun,
  front,
  renaming,
  onRenaming,
  onRename,
  onParent,
  onOther,
  onCloseChild,
  onCloseRun,
  mark,
  leading,
  trailing,
}: {
  task: Task
  /** 中间打开的子对话在父对话列表里的那一份（标题、状态）；列表还没取回来时为空 */
  child?: ChildSummary
  runName?: string
  openChild: string
  openRun: number
  /** 中间正显示父对话还是另一个页签 */
  front: 'parent' | 'other'
  /** 正在重命名时的草稿；null 表示没在改 */
  renaming: string | null
  onRenaming: (v: string | null) => void
  onRename: () => void
  onParent: () => void
  onOther: () => void
  onCloseChild: () => void
  onCloseRun: () => void
  /** 标题前的小标签（AI 分析开出的对话写「分析」），和普通对话一眼分开 */
  mark?: ReactNode
  /** 页签前面的项目名入口（点开是项目下的对话） */
  leading?: ReactNode
  trailing: ReactNode
}) {
  const busy = taskBusy(task)
  return (
    <TabBar as="header" label={t('对话页签')} leading={leading} trailing={trailing}>
      {renaming !== null ? (
        // 改名就地在页签位置上改：输入框不能套在页签按钮里
        <input
          autoFocus
          aria-label={t('任务标题')}
          value={renaming}
          maxLength={80}
          onChange={(e) => onRenaming(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={onRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
            if (e.key === 'Escape') onRenaming(null)
          }}
          className="mx-1.5 my-1 w-60 min-w-0 rounded-md border border-focus bg-field px-2 text-[0.75rem] outline-none"
        />
      ) : (
        <TabItem
          active={front === 'parent'}
          onSelect={onParent}
          onDoubleClick={() => onRenaming(task.title)}
          title={[task.title, cliAliveHint(task), t('双击重命名')].filter(Boolean).join(' · ')}
          className="basis-[13.5rem]"
          icon={
            <TaskStatusIcon
              status={task.status}
              working={busy}
              spin={busy}
              waiting={taskState(task) === 'needs'}
              label={taskWaitText(task) || undefined}
              className="h-3.5 w-3.5"
            />
          }
        >
          {mark && <span className="mr-1.5 inline-flex align-middle">{mark}</span>}
          {/* 对话（或名下子对话）有活着的 CLI：标题上流过一道高光 */}
          <span data-conv-title className={cn(cliTreeAlive(task) && 'cli-alive-title')}>
            {task.title}
          </span>
        </TabItem>
      )}
      {openChild && (
        <TabItem
          active={front === 'other'}
          onSelect={onOther}
          onClose={onCloseChild}
          closeLabel={t('关闭子对话')}
          tag={t('子对话')}
          className="basis-[12rem]"
          title={child?.title}
          icon={
            child ? (
              <TaskStatusIcon status={child.status} icon={childIcon(child)} className="h-3.5 w-3.5" />
            ) : (
              <MessageSquareText className="h-3.5 w-3.5" />
            )
          }
        >
          {child?.title ?? t('子对话')}
        </TabItem>
      )}
      {openRun > 0 && (
        <TabItem
          active={front === 'other'}
          onSelect={onOther}
          onClose={onCloseRun}
          closeLabel={t('关闭运行')}
          tag={t('运行 {n}', { n: openRun })}
          icon={<WorkflowIcon className="h-3.5 w-3.5" />}
        >
          {runName || t('工作流')}
        </TabItem>
      )}
    </TabBar>
  )
}
