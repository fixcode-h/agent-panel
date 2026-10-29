import { useMemo, useState } from 'react'
import { ClipboardList, GraduationCap, SearchCheck, Settings2, Sparkles, X } from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { parseDiagnosis } from '@shared/diagnosis'
import type { ReportKind } from '@/lib/analysis-report'
import { cn } from '@/lib/utils'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { IconButton } from '@/components/ui/icon-button'
import { LessonReviewReport } from '@/components/projects/LessonReview'
import { ProjectInitReport } from '@/components/projects/ProjectInitReport'
import { EvolutionReport } from './Evolution'
import { DiagnosisError, DiagnosisReport, diagnosisTabs, type DiagnosisTab } from './DiagnosisReport'

const KIND = {
  run: {
    icon: ClipboardList,
    title: () => t('分析报告'),
    desc: () => t('逐项修复在这个对话里进行，优化看过差异再应用'),
  },
  lessons: { icon: GraduationCap, title: () => t('教训评审'), desc: () => t('每条建议点「应用」才写进项目教训') },
  init: { icon: Settings2, title: () => t('项目设置'), desc: () => t('推荐的设置逐项应用，直接保存进项目') },
  diagnosis: {
    icon: SearchCheck,
    title: () => t('排查结论'),
    desc: () => t('修复建议可以发回被分析的对话，或开新任务修'),
  },
} satisfies Record<ReportKind, { icon: typeof Sparkles; title: () => string; desc: () => string }>

export const reportTitle = (kind: ReportKind) => KIND[kind].title()

/**
 * AI 分析对话右侧的功能面板（ADR 0016）：分析报告不再铺在对话区，画在这里逐项处理。
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
  // 排查结论：页签按结论里的条目分（结论 / 证据 / 修复 / 相关文件），读不出来时只留一个页签摆原文
  const diag = useMemo(() => (kind === 'diagnosis' ? parseDiagnosis(text) : null), [kind, text])
  const [tab, setTab] = useState<DiagnosisTab>('sum')
  return (
    <div className={cn('flex min-h-0 w-full flex-1 flex-col bg-rail', className)} data-analysis-panel={kind}>
      {/* 顶上是和文件栏同一套页签条（组件库 TabBar）：报告只有一种，页签就一个，收起按钮在右端 */}
      <TabBar label={t('功能面板')} trailing={<IconButton icon={X} label={t('收起功能面板')} onClick={onClose} />}>
        {diag?.ok ? (
          diagnosisTabs(diag.value).map((x) => (
            <TabItem
              key={x.id}
              active={tab === x.id}
              onSelect={() => setTab(x.id)}
              tag={x.count || undefined}
              className="basis-auto"
            >
              {x.label}
            </TabItem>
          ))
        ) : (
          <TabItem active onSelect={() => {}} icon={<Icon className="h-3.5 w-3.5" />}>
            {k.title()}
          </TabItem>
        )}
      </TabBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {kind !== 'diagnosis' && <p className="px-4 pt-3 text-[0.75rem] text-subtle">{k.desc()}</p>}
        {kind === 'diagnosis' ? (
          diag?.ok ? (
            <DiagnosisReport task={task} project={project} diagnosis={diag.value} tab={tab} onTask={onTask} />
          ) : (
            diag && <DiagnosisError parse={diag} />
          )
        ) : kind === 'run' ? (
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
