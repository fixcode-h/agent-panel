import type { ReactNode } from 'react'
import { Workflow as WorkflowIcon } from 'lucide-react'
import type { Task } from '@shared/schema'
import { taskBusy, taskState, taskWaitText } from '@shared/task'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { useNow } from '@/lib/useNow'
import { pad2 } from '@shared/datetime'
import { StatusPill } from '@/components/ui/status-pill'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { InlineRename } from '@/components/ui/inline-rename'
import { cliAliveHint, cliTreeAlive } from './CliAlive'
import { TaskStatusIcon } from './TaskStatusIcon'

/**
 * 对话页顶上的页签条（照 Proma）：父对话一个页签，不能关；旁边是中间打开的工作流运行，能关
 * （子对话在右栏开页签，不进这一条）。标题栏原来的按钮放在页签条右端（trailing）。
 * 页签的状态图标和侧栏同一处判定：父对话走 taskState，子对话走 childIcon
 */
export function ConversationTabs({
  task,
  runName,
  openRun,
  front,
  renaming,
  onRenaming,
  onRename,
  onParent,
  onOther,
  onCloseRun,
  mark,
  leading,
  trailing,
}: {
  task: Task
  runName?: string
  openRun: number
  /** 中间正显示父对话还是另一个页签 */
  front: 'parent' | 'other'
  /** 正在重命名时从哪个标题开始改；null 表示没在改 */
  renaming: string | null
  onRenaming: (v: string | null) => void
  /** 改名提交：交回输入框里的最终值，空串、没变由调用方判 */
  onRename: (title: string) => void
  onParent: () => void
  onOther: () => void
  onCloseRun: () => void
  /** 标题前的小标签（AI 分析开出的对话写「分析」），和普通对话一眼分开 */
  mark?: ReactNode
  /** 页签前面的项目名入口（点开是项目下的对话） */
  leading?: ReactNode
  trailing: ReactNode
}) {
  const busy = taskBusy(task)
  return (
    <TabBar
      as="header"
      label={t('对话页签')}
      leading={leading}
      trailing={
        <>
          <HeadStatus task={task} />
          {trailing}
        </>
      }
    >
      {renaming !== null ? (
        // 改名就地在页签位置上改：输入框不能套在页签按钮里
        <InlineRename
          value={renaming}
          label={t('任务标题')}
          size="sm"
          onCommit={onRename}
          onCancel={() => onRenaming(null)}
          className="mx-1.5 my-1 w-60"
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
      {openRun > 0 && (
        <TabItem
          active={front === 'other'}
          onSelect={onOther}
          onClose={onCloseRun}
          closeLabel={t('关闭运行')}
          title={[t('工作流'), runName, t('运行 {n}', { n: openRun })].filter(Boolean).join(' · ')}
          icon={<WorkflowIcon className="h-3.5 w-3.5" />}
        >
          {runName || t('工作流')}
          {/* 「运行 n」不再挂成灰胶囊，但读屏和按名字找页签时仍要认得出是哪一次运行 */}
          <span className="sr-only"> · {t('运行 {n}', { n: openRun })}</span>
        </TabItem>
      )}
    </TabBar>
  )
}

/** 秒数写成时钟样式（3:12、1:02:05）：页签条右端的胶囊位置窄，比「3m 12s」更紧凑 */
function clock(ms: number) {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h}:${pad2(m)}:${pad2(sec % 60)}` : `${m}:${pad2(sec % 60)}`
}

/**
 * 页签条右端的状态胶囊（设计稿「运行中 · 3:12」）：这一轮在跑时写用时（从最后一条用户消息算起），
 * 在等子对话 / 后台命令时写在等什么，有提问等你时琥珀色。状态只从 taskState 派生，不另判
 */
function HeadStatus({ task }: { task: Task }) {
  const state = taskState(task)
  const run = state === 'running'
  const now = useNow(run)
  if (run) {
    let from = task.updatedAt
    // 从后往前找最后一条用户消息（目标库没有 findLast）：每秒刷新一次，不整段 filter 拷贝
    for (let i = task.messages.length - 1; i >= 0; i--)
      if (task.messages[i].role === 'user') {
        from = task.messages[i].at
        break
      }
    return (
      <StatusPill tone="run" spin className="hidden tabular-nums md:inline-flex">
        {t('运行中')} · {clock(now - Date.parse(from))}
      </StatusPill>
    )
  }
  if (state === 'waiting')
    return (
      <StatusPill tone="run" spin className="hidden md:inline-flex">
        {taskWaitText(task) || t('运行中')}
      </StatusPill>
    )
  if (state === 'needs')
    return (
      <StatusPill tone="wait" className="hidden md:inline-flex">
        {t('等你回复')}
      </StatusPill>
    )
  return null
}
