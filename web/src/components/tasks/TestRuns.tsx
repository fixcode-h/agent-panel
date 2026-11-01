import { Check, ListChecks, Minus, X } from 'lucide-react'
import type { Task } from '@shared/schema'
import { type TestRunRow, testRunSummary } from '@shared/test-steps'
import { t } from '@shared/i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { cn } from '@/lib/utils'
import { META_CHIP } from './chip'

/**
 * 输入框下面的「测试记录」小块：这次跑过的项目测试步骤。
 * 数据只来自任务上的 testRuns（后端按后台命令的真实起止时间记的），这里不采集、不猜：
 * 没有记录时间的旧数据写「未记录」，失败的照实写失败。
 */
export function TestRunsChip({ task }: { task: Task }) {
  const summary = testRunSummary(task.testRuns)
  // 一条记录都没有（还没跑过）：不占这一行
  if (!summary.rows.length) return null
  const bad = summary.failed > 0
  return (
    <Popover>
      <PopoverTrigger className={cn(META_CHIP, bad && 'text-danger')} title={t('测试记录')} aria-label={t('测试记录')}>
        {bad ? (
          <X className="h-3.5 w-3.5 text-danger" />
        ) : summary.allPassed ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <ListChecks className="h-3.5 w-3.5" />
        )}
        <span className="font-mono tabular-nums">
          {summary.passed}/{summary.rows.length}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-[min(420px,calc(100vw-24px))]">
        <div className="flex flex-col gap-2.5 p-2.5 text-xs text-muted">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-fg">{t('测试记录')}</span>
            <span className="text-subtle">{t('合计耗时 {time}', { time: summary.durationText })}</span>
          </div>
          <ul className="flex flex-col gap-2">
            {summary.rows.map((r) => (
              <TestRunLine key={r.key} row={r} />
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 一条记录：步骤名、谁跑的、结果、真实耗时、第几次尝试 */
function TestRunLine({ row }: { row: TestRunRow }) {
  return (
    <li className="flex flex-col gap-1 border-t pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <ResultIcon state={row.state} />
        <span className="min-w-0 flex-1 truncate text-fg" title={row.stepName}>
          {row.stepName}
        </span>
        <span className="whitespace-nowrap font-mono text-subtle tabular-nums">{row.durationText}</span>
      </div>
      <span className="flex flex-wrap gap-x-2 pl-5 text-caption text-subtle">
        <span className={row.state === 'failed' ? 'text-danger' : row.state === 'passed' ? 'text-success' : undefined}>
          {row.resultText}
        </span>
        <span>{t('由{by}执行', { by: row.byText })}</span>
        {row.tries > 1 && <span>{t('第 {n} 次', { n: row.tries })}</span>}
      </span>
    </li>
  )
}

function ResultIcon({ state }: { state: TestRunRow['state'] }) {
  if (state === 'passed') return <Check className="h-3.5 w-3.5 shrink-0 text-success" />
  if (state === 'failed') return <X className="h-3.5 w-3.5 shrink-0 text-danger" />
  return <Minus className="h-3.5 w-3.5 shrink-0 text-subtle" />
}
