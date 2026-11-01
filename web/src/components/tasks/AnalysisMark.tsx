import { Sparkles } from 'lucide-react'
import type { AnalysisKind } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

const label = (kind?: AnalysisKind) =>
  kind === 'fix' ? t('排查') : kind === 'lessons' ? t('评审') : kind === 'init' ? t('初始化') : t('分析')

/**
 * AI 分析开出的对话在标题前的标记（用户 2026-10-25 要求和别的对话标题明显区分）：
 * 侧栏、项目首页、子对话栏和对话标题栏用同一个，强调色的小标签写着是哪种分析
 */
export function AnalysisMark({ kind, className }: { kind?: AnalysisKind; className?: string }) {
  return (
    <span
      data-analysis-mark
      title={t('AI 分析开出的对话')}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-md bg-accent-soft px-1.5 py-px text-caption leading-4 font-medium text-accent-text',
        className,
      )}
    >
      <Sparkles className="h-3 w-3" />
      {label(kind)}
    </span>
  )
}
