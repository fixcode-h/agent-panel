import { Check } from 'lucide-react'
import type { Diagnosis } from '@shared/bug-diagnosis-schema'
import { causeInPlan, phaseOf } from '@shared/bug-phase'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 一份报告落在阶段条的第几步：快速级别根因和方案合成一版，算在方案那一步；修复这一步没有单独的报告 */
const STEP = { evidence: 0, cause: 1, plan: 2, verify: 4 } as const

/**
 * 诊断报告弹窗正文上方吸顶的阶段条（用户 2026-11-05 定的流程）：论证 → 根因 → 修复方案 → 修复 → 验证，
 * 按整份档案标出现在走到哪一步；论证写第几轮、在等你复现时写出来。
 * 走过的和正在的那一步能点，切到那一步最后交的一份报告（用户 2026-11-06 要求），还没走到的不能点；
 * 正在看的那一步加一圈描边
 */
export function DiagnosisStages({
  list,
  shown,
  onShow,
}: {
  list: Diagnosis[]
  /** 正在看的那一版（Diagnosis.version 的字符串） */
  shown: string
  onShow: (key: string) => void
}) {
  const d = list.at(-1)
  if (!d) return null
  const phase = phaseOf(d)
  const rounds = list.filter((x) => phaseOf(x) === 'evidence').length
  const ok = d.status === 'approved' || d.status === 'answered'
  // 现在在第几步：根因同意了就到方案，方案确认了就到修复；验证给了结果它还在分析，点了结束才算都完成
  const at =
    phase === 'evidence'
      ? 0
      : phase === 'cause'
        ? ok
          ? 2
          : 1
        : phase === 'plan'
          ? ok
            ? 3
            : 2
          : d.status === 'approved'
            ? 5
            : 4
  const evidence =
    phase === 'evidence' && d.status === 'pending' && d.awaiting
      ? t('论证 · 第 {n} 轮 · 等你复现', { n: rounds })
      : rounds > 0
        ? t('论证 · 第 {n} 轮', { n: rounds })
        : t('论证')
  const names = [evidence, t('根因'), t('修复方案'), t('修复'), t('验证')]
  // 每一步最后交的那份报告；根因没单独交过、合在快速级别的方案里时，点根因看那份方案
  const own = names.map((_, i) => [...list].reverse().find((x) => STEP[phaseOf(x)] === i))
  // 一上来就证实了、直接交根因（没有单独的论证报告）时，论证这一步照样算走过，
  // 点它看最早那份报告：论证的证据写在它的「证据」里（用户 2026-11-09 报「论证没法点」）
  const borrowed = !own[0] ? list[0] : undefined
  const target = own.map((hit, i) => {
    if (hit) return hit
    if (i === 0) return borrowed
    if (i === 1) return [...list].reverse().find((x) => causeInPlan(x, list))
    return undefined
  })
  const viewing = list.find((x) => String(x.version) === shown) ?? d
  const viewStep = STEP[phaseOf(viewing)]
  return (
    <ol aria-label={t('排查阶段')} className="flex flex-wrap items-center gap-1.5">
      {names.map((n, i) => {
        const hit = i <= at ? target[i] : undefined
        const key = hit && String(hit.version)
        return (
          <li key={i} className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!key}
              aria-current={i === at ? 'step' : undefined}
              aria-pressed={key ? i === viewStep : undefined}
              title={
                key
                  ? i === 0 && borrowed
                    ? t('没有单独的论证报告，证据写在这份报告里')
                    : t('查看这一步的报告')
                  : i === 3 && i < at
                    ? t('修复这一步没有单独的报告，改了什么写在验证报告里')
                    : undefined
              }
              onClick={() => key && key !== shown && onShow(key)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs transition-colors',
                i < at && 'bg-success/10 text-success',
                i === at && 'bg-warning/12 font-medium text-warning',
                i > at && 'text-subtle',
                key ? 'cursor-pointer' : 'cursor-default',
                i < at && key && 'hover:bg-success/18',
                i === at && key && 'hover:bg-warning/20',
                // 正在看的那一步：一圈和字同色的细描边
                key && i === viewStep && 'ring-1 ring-current/50 ring-inset',
              )}
            >
              {i < at && <Check className="h-3 w-3" strokeWidth={3} />}
              {n}
            </button>
            {i < names.length - 1 && <span aria-hidden className="h-px w-3 bg-line-strong" />}
          </li>
        )
      })}
    </ol>
  )
}
