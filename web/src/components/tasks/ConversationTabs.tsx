import type { ReactNode } from 'react'
import { Workflow as WorkflowIcon } from 'lucide-react'
import type { Task } from '@shared/schema'
import { liveBusy, liveWord } from '@shared/live/task-live'
import { useLive } from '@/lib/live/store'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { useNow } from '@/lib/useNow'
import { headStatus } from './head-status'
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
  // 状态只读服务端给的 live（web/src/lib/live/store.ts），和侧栏、项目首页同一份
  const live = useLive(task)
  const busy = liveBusy(live)
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
          title={[task.title, cliAliveHint(live), t('双击重命名')].filter(Boolean).join(' · ')}
          className="basis-[13.5rem]"
          icon={
            <TaskStatusIcon
              status={task.status}
              working={busy}
              spin={busy}
              waiting={live.state === 'needs'}
              label={liveWord(live)}
              className="h-3.5 w-3.5"
            />
          }
        >
          {mark && <span className="mr-1.5 inline-flex align-middle">{mark}</span>}
          {/* 对话（或名下子对话）有活着的 CLI：标题上流过一道高光 */}
          <span data-conv-title className={cn(cliTreeAlive(live) && 'cli-alive-title')}>
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

/**
 * 页签条右端的胶囊：这一位置只显示累计执行时长，不随新消息重置，也不切成「子对话执行中」；
 * 在等什么放进悬停提示（等子对话 / 后台命令 / 工作流），有提问等你时仍是琥珀提示。
 * 运行中、等结果都每秒刷新：等后台命令、工作流时这一段可能还在累计。
 */
function HeadStatus({ task }: { task: Task }) {
  const live = useLive(task)
  const now = useNow(liveBusy(live))
  const view = headStatus(task, live, now)
  if (!view) return null
  return (
    <StatusPill
      tone={view.tone}
      spin={view.spin}
      title={view.hint}
      className={cn('hidden md:inline-flex', view.tone === 'run' && 'tabular-nums')}
    >
      {/* 可见的只留时长；等什么放进读屏说明——generic 的 span 不认 aria-label，用 sr-only 文本 */}
      <span data-head-clock aria-hidden>
        {view.text}
      </span>
      <span className="sr-only">{view.hint}</span>
    </StatusPill>
  )
}
