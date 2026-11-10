import { Check } from 'lucide-react'
import { bugPhaseText } from '@shared/bug-overview'
import { BUG_PHASES } from '@shared/bug-stats'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 一个阶段的状态和它在提示里的记号：走过的打勾、正在的实心点、还没到的空心圈 */
const MARK = { done: '✓', now: '●', todo: '○' } as const

/**
 * 父对话里 Bug 子对话那一行的五个小点（分析稿 U8）：论证 / 根因 / 修复方案 / 修复 / 验证，
 * 走过的打勾、正在的实心点、没到的空心圈，不用打开报告弹窗就知道走到哪一步。
 * step 是 shared/bug-overview.ts 的 bugStep（0–4，5 是都走完了），和总览 Bug 视图、报告弹窗的阶段条同一个算法。
 * 名字写在悬停提示和读屏说明里，行很窄，点上不写字
 */
export function BugStepDots({ step, className }: { step: number; className?: string }) {
  const marks = BUG_PHASES.map((p, i) => ({
    name: bugPhaseText(p),
    state: i < step ? 'done' : i === step ? 'now' : 'todo',
  })) as { name: string; state: keyof typeof MARK }[]
  const label = t('排查进度：{list}', { list: marks.map((m) => `${m.name} ${MARK[m.state]}`).join(t('，')) })
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-bug-steps={step}
      className={cn('inline-flex items-center gap-[3px] align-middle', className)}
    >
      {marks.map((m, i) =>
        m.state === 'done' ? (
          <Check key={i} aria-hidden className="h-2.5 w-2.5 text-success" strokeWidth={3.2} />
        ) : (
          <span
            key={i}
            aria-hidden
            className={cn(
              'block h-[7px] w-[7px] shrink-0 rounded-full',
              m.state === 'now' ? 'bg-accent' : 'border-[1.5px] border-current opacity-50',
            )}
          />
        ),
      )}
    </span>
  )
}
