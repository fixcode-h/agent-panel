import { nextRunLabel, nextToRun, willRunAgain, type ScheduleBucket } from '@shared/schedule'
import { t } from '@shared/i18n'

/**
 * 页头的一条概览：下一次是谁、什么时候，以及待执行 / 出过问题的数量。
 * 分组、排序和「还会不会跑」都读 shared/schedule.ts 的现成结果，不在这里另判一次。
 */
export function ScheduleOverview({
  buckets,
  now,
  onJumpToProblem,
}: {
  buckets: ScheduleBucket[]
  now: number
  /** 有问题时点数量跳到「出过问题」组 */
  onJumpToProblem: () => void
}) {
  // 计数和「下一次执行」读同一个集合：还会自动执行的计划（出过问题但没停用的也算），
  // 所以「待执行」和「出过问题」可以重叠，也不会出现「没有待执行的计划 / 待执行 1」
  const all = buckets.flatMap((b) => b.items)
  const willRun = all.filter(willRunAgain).length
  const problems = buckets.find((b) => b.group === 'problem')?.items.length ?? 0
  const next = nextToRun(all)

  return (
    <section
      aria-label={t('计划概览')}
      className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl bg-card shadow-card px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs text-subtle">{t('下一次执行')}</p>
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.9375rem]">
          {next ? (
            <>
              <span className="min-w-0 truncate font-semibold">{next.name}</span>
              <span className="text-muted tabular-nums">{nextRunLabel(next, now)}</span>
            </>
          ) : (
            <span className="text-subtle">{t('没有待执行的计划')}</span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-5 text-xs text-muted">
        <span>
          {t('待执行')} <span className="font-semibold text-fg tabular-nums">{willRun}</span>
        </span>
        {problems > 0 ? (
          <button
            type="button"
            onClick={onJumpToProblem}
            className="cursor-pointer rounded-md text-muted hover:text-fg"
          >
            {t('出过问题')} <span className="font-semibold text-warning tabular-nums">{problems}</span>
          </button>
        ) : (
          <span>
            {t('出过问题')} <span className="font-semibold text-fg tabular-nums">0</span>
          </span>
        )}
      </div>
    </section>
  )
}
