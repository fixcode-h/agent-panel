import { LayoutGrid, MessagesSquare, PenLine, Sparkles, Wand2 } from 'lucide-react'
import type { AnalysisArea, AnalysisFinding, DesignAnalysis } from '@shared/design-analysis'
import { CopyButton } from '@/components/chat/ChatMessage'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { t } from '@shared/i18n'

const AREAS: { area: AnalysisArea; title: string; icon: typeof MessagesSquare }[] = [
  { area: 'process', title: t('对话过程问题'), icon: MessagesSquare },
  { area: 'ui', title: t('UI 结果问题'), icon: LayoutGrid },
  { area: 'capability', title: t('生成能力改进建议'), icon: Wand2 },
]

const PRIORITY: Record<AnalysisFinding['priority'], { label: string; className: string }> = {
  high: { label: t('高'), className: 'bg-danger/10 text-danger' },
  medium: { label: t('中'), className: 'bg-warning/12 text-warning' },
  low: { label: t('低'), className: 'bg-sel text-subtle' },
}

/** 生成能力建议按高中低排，其余按模型给的顺序 */
function sortFindings(list: AnalysisFinding[]) {
  const rank = { high: 0, medium: 1, low: 2 } as const
  return [...list].sort((a, b) => rank[a.priority] - rank[b.priority])
}

/**
 * 「AI 分析」的结果卡片：对话过程、UI 结果、生成能力三段。
 * 每条带证据和可直接执行的修改要求，点「按建议修改」把要求发给对话。
 */
export function DesignAnalysisCard({
  analysis,
  disabled,
  onApply,
}: {
  analysis: DesignAnalysis
  /** 正在发消息或执行时不能再发 */
  disabled?: boolean
  onApply?: (text: string) => void
}) {
  const groups = AREAS.map((a) => ({
    ...a,
    list:
      a.area === 'capability'
        ? sortFindings(analysis.findings.filter((f) => f.area === a.area))
        : analysis.findings.filter((f) => f.area === a.area),
  }))
  return (
    <div className="mt-1.5 rounded-xl bg-card shadow-card/70 p-2.5 shadow-card">
      <div className="flex items-center gap-1.5 px-0.5 text-[0.75rem] font-medium">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-text" />
        <span className="min-w-0 flex-1">{t('AI 分析结果')}</span>
        <span className="shrink-0 text-[0.6875rem] font-normal text-subtle">
          {t('{n} 条建议', { n: analysis.findings.length })}
        </span>
      </div>
      {!analysis.findings.length ? (
        <p className="mt-2 px-0.5 text-[0.75rem] leading-relaxed text-muted">
          {t('这次没有解析出结构化的检查项，可以先看上面的结论，或者再分析一次。')}
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2.5">
          {groups.map(({ area, title, icon: Icon, list }) => (
            <section key={area} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 px-0.5 text-[0.75rem] font-medium text-muted">
                <Icon className="h-3.5 w-3.5 shrink-0 text-accent-text" />
                <span>{title}</span>
                <span className="text-[0.6875rem] font-normal text-subtle">{list.length}</span>
              </div>
              {!list.length ? (
                <p className="px-0.5 text-[0.6875rem] text-subtle">{t('没有发现明显问题')}</p>
              ) : (
                list.map((f, i) => (
                  <Finding
                    key={`${f.area}:${i}:${f.title}`}
                    finding={f}
                    disabled={disabled}
                    onApply={onApply}
                    showPriority={area === 'capability'}
                  />
                ))
              )}
            </section>
          ))}
        </div>
      )}
      {!!analysis.findings.some((f) => f.suggestion) && (
        <p className="mt-2 border-t px-0.5 pt-2 text-[0.6875rem] leading-relaxed text-subtle">
          {t('「按建议修改」会把这条要求作为一条新消息发给 AI；想改措辞可以先复制。')}
        </p>
      )}
    </div>
  )
}

function Finding({
  finding,
  disabled,
  onApply,
  showPriority,
}: {
  finding: AnalysisFinding
  disabled?: boolean
  onApply?: (text: string) => void
  showPriority?: boolean
}) {
  const p = PRIORITY[finding.priority]
  return (
    <div className="rounded-lg bg-bg/60 p-2">
      <div className="flex min-w-0 items-start gap-1.5">
        <span className="min-w-0 flex-1 text-[0.75rem] leading-snug font-medium">{finding.title}</span>
        {showPriority && (
          <span className={cn('shrink-0 rounded px-1 py-px text-[0.625rem] font-medium', p.className)}>{p.label}</span>
        )}
      </div>
      {finding.detail && (
        <p className="mt-1 text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-muted">{finding.detail}</p>
      )}
      {finding.evidence && (
        <p className="mt-1 rounded bg-sel/60 px-1.5 py-1 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-subtle">
          {t('证据：')}
          {finding.evidence}
        </p>
      )}
      {finding.suggestion && (
        <div className="mt-1.5 flex items-start gap-1">
          <p className="min-w-0 flex-1 text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-fg/85">
            {finding.suggestion}
          </p>
          <div className="flex shrink-0 items-center gap-0.5">
            <CopyButton text={finding.suggestion} label={t('复制这条建议')} className="h-6 w-6 rounded-md" />
            {onApply && (
              <Button
                variant="link"
                disabled={disabled}
                onClick={() => onApply(finding.suggestion)}
                title={disabled ? t('等当前这一轮结束再修改') : t('把这条要求发给 AI')}
                className="h-6 shrink-0 px-1.5 text-[0.6875rem]"
              >
                <PenLine className="h-3 w-3" />
                {t('按建议修改')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
