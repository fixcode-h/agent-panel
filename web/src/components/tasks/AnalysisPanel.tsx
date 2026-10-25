import { ClipboardList, GraduationCap, Settings2, Sparkles, X } from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { t } from '@shared/i18n'
import type { ReportKind } from '@/lib/analysis-report'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { LessonReviewReport } from '@/components/projects/LessonReview'
import { ProjectInitReport } from '@/components/projects/ProjectInitReport'
import { EvolutionReport } from './Evolution'

const KIND = {
  run: {
    icon: ClipboardList,
    title: () => t('分析报告'),
    desc: () => t('逐项修复在这个对话里进行，优化看过差异再应用'),
  },
  lessons: { icon: GraduationCap, title: () => t('教训评审'), desc: () => t('每条建议点「应用」才写进项目教训') },
  init: { icon: Settings2, title: () => t('项目设置'), desc: () => t('推荐的设置逐项应用，直接保存进项目') },
} satisfies Record<ReportKind, { icon: typeof Sparkles; title: () => string; desc: () => string }>

export const reportTitle = (kind: ReportKind) => KIND[kind].title()

/**
 * AI 分析对话右侧的功能面板（ADR 0015）：分析报告不再铺在对话区，画在这里逐项处理。
 * 执行分析是代码问题和优化建议（修复在当前对话里做）、教训评审是逐条应用、项目初始化是推荐设置的应用面板
 */
export function AnalysisPanel({
  task,
  project,
  kind,
  text,
  onTask,
  onClose,
  className,
}: {
  task: Task
  project?: Project
  kind: ReportKind
  /** 报告所在的那条回复 */
  text: string
  onTask: (task: Task) => void
  onClose: () => void
  className?: string
}) {
  const k = KIND[kind]
  const Icon = k.icon
  const first = task.messages.find((m) => m.role === 'user')?.text ?? ''
  return (
    <div className={cn('flex min-h-0 w-full flex-1 flex-col bg-rail', className)} data-analysis-panel={kind}>
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[0.8125rem] font-semibold">{k.title()}</span>
          <span className="truncate text-[0.6875rem] text-subtle">{k.desc()}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('收起功能面板')}
          title={t('收起功能面板')}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {kind === 'run' ? (
          <EvolutionReport task={task} project={project} text={text} onTask={onTask} />
        ) : kind === 'lessons' ? (
          <LessonReviewReport text={text} project={project} />
        ) : (
          <ProjectInitReport project={project} text={text} prompt={first} />
        )}
      </div>
    </div>
  )
}
