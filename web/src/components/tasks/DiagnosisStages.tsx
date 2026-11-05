import { Check } from 'lucide-react'
import type { Diagnosis } from '@shared/bug-diagnosis-schema'
import { phaseOf } from '@shared/bug-phase'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/**
 * 诊断报告弹窗正文上方的阶段条（用户 2026-11-05 定的流程）：论证 → 根因 → 修复方案 → 修复 → 验证，
 * 标出现在在哪一步；论证写第几轮、在等你复现时写出来
 */
export function DiagnosisStages({ list }: { list: Diagnosis[] }) {
  const d = list.at(-1)
  if (!d) return null
  const phase = phaseOf(d)
  const rounds = list.filter((x) => phaseOf(x) === 'evidence').length
  const ok = d.status === 'approved' || d.status === 'answered'
  // 现在在第几步：根因同意了就到方案，方案确认了就到修复，验证有了结果就都完成
  const at = phase === 'evidence' ? 0 : phase === 'cause' ? (ok ? 2 : 1) : phase === 'plan' ? (ok ? 3 : 2) : ok ? 5 : 4
  const evidence =
    phase === 'evidence' && d.status === 'pending' && d.awaiting
      ? t('论证 · 第 {n} 轮 · 等你复现', { n: rounds })
      : rounds > 0
        ? t('论证 · 第 {n} 轮', { n: rounds })
        : t('论证')
  const names = [evidence, t('根因'), t('修复方案'), t('修复'), t('验证')]
  return (
    <ol aria-label={t('排查阶段')} className="mb-4 flex flex-wrap items-center gap-1.5">
      {names.map((n, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span
            aria-current={i === at ? 'step' : undefined}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs',
              i < at && 'bg-success/10 text-success',
              i === at && 'bg-warning/12 font-medium text-warning',
              i > at && 'text-subtle',
            )}
          >
            {i < at && <Check className="h-3 w-3" strokeWidth={3} />}
            {n}
          </span>
          {i < names.length - 1 && <span aria-hidden className="h-px w-3 bg-line-strong" />}
        </li>
      ))}
    </ol>
  )
}
