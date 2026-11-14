import { useMemo, useState } from 'react'
import { ClipboardList, GraduationCap, SearchCheck, Settings2, Sparkles, X } from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { parseDiagnosis } from '@shared/diagnosis'
import { findReport, type FoundReport, type ReportKind } from '@/lib/analysis-report'
import { usePluginReports, type OwnedReport } from '@/plugins/registry'
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
} satisfies Record<Exclude<ReportKind, 'plugin'>, { icon: typeof Sparkles; title: () => string; desc: () => string }>

/** 对话里的报告，带上页签名字；插件的报告带上它登记的那一项（插件关掉后不再认） */
export type TaskReport = FoundReport & { title: string; own?: OwnedReport }

/** 这个对话右侧功能面板画哪份报告：面板自己的几种 + 开着的插件登记的（WebPlugin.reports） */
export function useTaskReport(task: Task | null | undefined): TaskReport | null {
  const plugins = usePluginReports()
  return useMemo(() => {
    const r = task ? findReport(task, plugins) : null
    if (!r) return null
    const own = r.plugin ? plugins.find((p) => p.key === r.plugin) : undefined
    return { ...r, own, title: own ? own.title : KIND[r.kind as Exclude<ReportKind, 'plugin'>].title() }
  }, [task, plugins])
}

/**
 * AI 分析对话右侧的功能面板（ADR 0016）：分析报告不再铺在对话区，画在这里逐项处理。
 * 执行分析是代码问题和优化建议（修复在当前对话里做）、教训评审是逐条应用、项目初始化是推荐设置的应用面板
 */
export function AnalysisPanel({
  task,
  project,
  report,
  onTask,
  onClose,
  className,
}: {
  task: Task
  project?: Project
  report: TaskReport
  onTask: (task: Task) => void
  onClose: () => void
  className?: string
}) {
  const { kind, own } = report
  /** 报告所在的那条回复 */
  const text = report.message.text
  const k = own
    ? { icon: own.icon ?? Sparkles, title: () => own.title, desc: () => own.desc ?? '' }
    : KIND[kind as Exclude<ReportKind, 'plugin'>]
  const Icon = k.icon
  const first = task.messages.find((m) => m.role === 'user')?.text ?? ''
  // 排查结论：页签按结论里的条目分（结论 / 证据 / 修复 / 相关文件），读不出来时只留一个页签摆原文
  const diag = useMemo(() => (kind === 'diagnosis' ? parseDiagnosis(text) : null), [kind, text])
  const [tab, setTab] = useState<DiagnosisTab>('sum')
  return (
    <div className={cn('flex min-h-0 w-full flex-1 flex-col bg-rail', className)} data-analysis-panel={kind}>
      {/* 顶上是页签条（组件库 TabBar 的 fit：按文字宽度排、计数是小圆块，和对话右栏同一套）：
          照设计稿 AiWindow 高 44、透出面板底色、选中的加粗；报告只有一种时页签就一个，收起按钮在右端 */}
      <TabBar
        label={t('功能面板')}
        variant="fit"
        className="h-11 bg-transparent"
        trailing={<IconButton icon={X} label={t('收起功能面板')} onClick={onClose} />}
      >
        {diag?.ok ? (
          diagnosisTabs(diag.value).map((x) => (
            <TabItem
              key={x.id}
              active={tab === x.id}
              onSelect={() => setTab(x.id)}
              tag={x.count || undefined}
              className={cn(tab === x.id && 'font-semibold')}
            >
              {x.label}
            </TabItem>
          ))
        ) : (
          <TabItem active onSelect={() => {}} icon={<Icon className="h-3.5 w-3.5" />} className="font-semibold">
            {k.title()}
          </TabItem>
        )}
      </TabBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {kind !== 'diagnosis' && k.desc() && <p className="px-[1.125rem] pt-3 text-footnote text-subtle">{k.desc()}</p>}
        {kind === 'diagnosis' ? (
          diag?.ok ? (
            <DiagnosisReport task={task} project={project} diagnosis={diag.value} tab={tab} onTask={onTask} />
          ) : (
            diag && <DiagnosisError parse={diag} />
          )
        ) : own ? (
          <own.Report task={task} messageId={report.message.id} text={text} />
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
