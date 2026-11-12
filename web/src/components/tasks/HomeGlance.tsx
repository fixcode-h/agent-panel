import { BookOpen, ChevronRight, Coffee, Folder, MessageSquare, TestTube, Wrench, type LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import { overviewRows, type OverviewRow } from '@shared/overview'
import { timeAgo } from '@shared/task'
import { liveWaitText } from '@shared/task-live'
import { useLive, useLiveOf } from '@/lib/live-store'
import { useData, useNav, useTasks } from '@/lib/data'
import { cn } from '@/lib/utils'
import { StatusPill } from '@/components/ui/status-pill'
import { useAway } from '@/components/overview/AwayCard'

/** 首页列出来的条数：只是一眼看个大概，完整的在总览 */
const WAIT_MAX = 3
const RECENT_MAX = 3

/** 第一次用（一个对话都没有）时的示例：点了填进输入框，用户改两句就能发 */
const EXAMPLES: { icon: LucideIcon; label: string; prompt: string }[] = [
  {
    icon: BookOpen,
    label: t('了解这个项目'),
    prompt: t(
      '通读这个项目，讲清楚它是做什么的、目录怎么分、主要模块之间怎么调用，最后列出你觉得最需要注意的三个地方。',
    ),
  },
  {
    icon: TestTube,
    label: t('补上缺的测试'),
    prompt: t('找出最重要、却还没有测试覆盖的几个函数，给它们补上单元测试并跑通。'),
  },
  {
    icon: Wrench,
    label: t('照着文档跑一遍'),
    prompt: t('按 README 的快速开始从头跑一遍，哪一步跑不通或和文档对不上，就修好代码或改正文档。'),
  },
]

/**
 * 首页输入框下面（分析稿 U6）：回到面板最想先知道哪些在等你。
 * 「等你处理 N 件」和最近三个对话，点一行直接进那个对话；分组口径和总览页同一份（shared/overview.ts）。
 * 一个对话都没有时换成三个示例任务，点了填进输入框
 */
export function HomeGlance({ onExample }: { onExample: (prompt: string) => void }) {
  const { tasks, tasksLoaded } = useTasks()
  const { projects } = useData()
  const { go } = useNav()
  const [away] = useAway()
  const liveOf = useLiveOf()
  if (!tasksLoaded) return null

  if (!tasks.length)
    return (
      <section aria-label={t('试试这些')} className="flex flex-col gap-2" data-home-examples>
        <h2 className="px-1 text-xs text-subtle">{t('试试这些')}</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {EXAMPLES.map((x) => (
            <button
              key={x.label}
              type="button"
              onClick={() => onExample(x.prompt)}
              className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line/70 px-3 py-2.5 text-left transition-colors hover:bg-sel/60 focus-visible:ring-[3px] focus-visible:ring-focus-soft focus-visible:outline-none"
              data-home-example
            >
              <x.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body text-fg">{x.label}</span>
                <span className="line-clamp-2 text-xs text-subtle">{x.prompt}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    )

  const rows = overviewRows(tasks, liveOf)
  // 只列得下三件：真要你回答的排最前，其次是失败的，做完没看的最后（组内原本按时间排，这里是稳定排序）
  const urgency = (r: OverviewRow) => (r.state === 'needs' ? 0 : r.state === 'failed' ? 1 : 2)
  const waiting = rows.filter((r) => r.group === 'you').sort((a, b) => urgency(a) - urgency(b))
  const shownWaiting = waiting.slice(0, WAIT_MAX)
  // 最近的对话不重复上面已经列出来的那几件；等你处理的超出部分照样能出现在这里
  const recent = rows
    .filter((r) => !shownWaiting.includes(r))
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt))
    .slice(0, RECENT_MAX)
  const projectName = (id: string) => (id ? (projects.find((p) => p.id === id)?.name ?? t('已删除的项目')) : t('聊天'))
  const open = (r: OverviewRow) =>
    r.task.projectId
      ? go({ page: 'projects', id: r.task.projectId, sub: r.task.id })
      : go({ page: 'chat', id: r.task.id })
  const picks = away?.picks.length ?? 0

  return (
    <div className="flex flex-col gap-4" data-home-glance>
      {away?.on && (
        // 「我不在」开着：回来先提醒一句，点了去总览看替你选过的
        <button
          type="button"
          onClick={() => go({ page: 'overview' })}
          className="flex cursor-pointer items-center gap-2 self-start rounded-full bg-accent-soft px-3 py-1 text-xs text-accent-text transition-opacity hover:opacity-85"
          data-home-away
        >
          <Coffee className="h-3.5 w-3.5" />
          {picks ? t('「我不在」开着 · 替你选了 {n} 项', { n: picks }) : t('「我不在」开着')}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
      {waiting.length > 0 && (
        <section aria-label={t('等你处理')} className="flex flex-col gap-1" data-home-waiting>
          <button
            type="button"
            // 只有一件时直接进那个对话，多件时去总览看全部
            onClick={() => (waiting.length === 1 ? open(waiting[0]) : go({ page: 'overview' }))}
            className="flex cursor-pointer items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-accent-text hover:underline"
          >
            {t('等你处理 {n} 件', { n: waiting.length })}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <ul className="flex flex-col">
            {shownWaiting.map((r) => (
              <GlanceRow key={r.task.id} r={r} project={projectName(r.task.projectId)} onOpen={() => open(r)} />
            ))}
          </ul>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-label={t('最近')} className="flex flex-col gap-1" data-home-recent>
          <h2 className="px-1 text-xs text-subtle">{t('最近')}</h2>
          <ul className="flex flex-col">
            {recent.map((r) => (
              <GlanceRow key={r.task.id} r={r} project={projectName(r.task.projectId)} onOpen={() => open(r)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** 一行：类型图标、标题、项目和在等什么、多久前；等你的那几行行尾一个琥珀胶囊 */
function GlanceRow({ r, project, onOpen }: { r: OverviewRow; project: string; onOpen: () => void }) {
  const { task, state } = r
  const Icon = task.projectId ? Folder : MessageSquare
  const live = useLive(task)
  const note = state === 'waiting' ? liveWaitText(live) : ''
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-sel/60 focus-visible:ring-[3px] focus-visible:ring-focus-soft focus-visible:outline-none"
        data-home-row={task.id}
      >
        <Icon className="h-4 w-4 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate text-body text-fg">{task.title}</span>
        <span className={cn('hidden min-w-0 max-w-[40%] truncate text-xs text-subtle sm:block')}>
          {note ? `${project} · ${note}` : project}
        </span>
        {r.group === 'you' ? (
          <StatusPill tone={state === 'failed' ? 'err' : state === 'needs' ? 'wait' : 'ok'}>
            {state === 'failed' ? t('失败') : state === 'needs' ? t('等你回复') : t('待查看')}
          </StatusPill>
        ) : (
          <span className="shrink-0 text-xs text-subtle tabular-nums">{timeAgo(task.updatedAt)}</span>
        )}
      </button>
    </li>
  )
}
