import { Plus, Sparkles } from 'lucide-react'
import { WORKDAY_PLAN, workdayTimeLabel } from '@shared/schedule'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'

/**
 * 空状态：先把「计划 → 到点 → 新建对话」这条关系讲清楚，再给模板和空白两种入口。
 * 模板名和时刻都从 WORKDAY_PLAN 取，不在这里另写一份。
 */
export function ScheduleEmpty({
  onCreateTemplate,
  onCreateBlank,
}: {
  onCreateTemplate: () => void
  onCreateBlank: () => void
}) {
  const steps = [
    { title: t('到点'), detail: t('按排期自动触发，不用手动开对话') },
    { title: t('新建对话'), detail: t('带着你写的提示词和选定的角色') },
    { title: t('在项目里执行'), detail: t('产出留在对话里，随时打开继续') },
  ]

  return (
    <EmptyPanel as="div" size="xl" className="flex flex-col items-center gap-6 text-fg">
      <div>
        <h2 className="text-[0.9375rem] font-semibold">{t('还没有计划')}</h2>
        <p className="mt-1 max-w-[420px] text-[0.8125rem] leading-relaxed text-subtle">
          {t('计划到点会自动新建一个对话去执行，过程和结果都留在对话里。')}
        </p>
      </div>

      <ol className="grid w-full max-w-[620px] gap-2 text-left sm:grid-cols-3">
        {steps.map((step, i) => (
          <Card key={step.title} as="li" className="flex gap-2 px-3 py-2.5">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-field text-[0.6875rem] font-semibold text-muted tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-medium">{step.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-subtle">{step.detail}</p>
            </div>
          </Card>
        ))}
      </ol>

      <Card padding="md" className="flex w-full max-w-[420px] flex-col gap-3 text-left">
        <div>
          <p className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
            <Sparkles className="h-3.5 w-3.5 text-accent-text" />
            {WORKDAY_PLAN.name}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            {t('每天 {time} 总结当天的工作', { time: workdayTimeLabel() })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onCreateTemplate}>
            <Plus className="h-4 w-4" />
            {t('新建今日工作')}
          </Button>
          <Button variant="secondary" onClick={onCreateBlank}>
            {t('新建空白计划')}
          </Button>
        </div>
      </Card>
    </EmptyPanel>
  )
}
