import { ymd } from '@shared/datetime'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { fieldClass, Input } from '@/components/ui/input'

/** 选「到某天」时预填的日子：一个月后，用户一般只是在这附近挑 */
const DEFAULT_END_DAYS = 30

/**
 * 计划的「结束」（照设计稿）：永不 / 到某天，两个单选格并排；选了「到某天」下面出日期。
 * value 是结束日期（YYYY-MM-DD，含这一天），空表示永不。编辑弹窗和详情面板共用
 */
export function EndChoice({
  value,
  onChange,
  compact = false,
}: {
  value: string
  onChange: (v: string) => void
  /** 详情面板里用矮一档的格子（h-8），和旁边的字段对齐 */
  compact?: boolean
}) {
  const until = !!value
  const pickUntil = () => {
    if (until) return
    const d = new Date()
    d.setDate(d.getDate() + DEFAULT_END_DAYS)
    onChange(ymd(d))
  }
  const option = (on: boolean, label: string, pick: () => void) => (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={pick}
      className={cn(
        fieldClass,
        'flex flex-1 cursor-pointer items-center gap-2 text-left text-[0.8125rem]',
        compact ? 'h-8' : 'h-10',
        !on && 'text-subtle hover:text-fg',
      )}
    >
      {/* 选中是粗环、没选是细环：和设计稿一样只靠环的粗细分 */}
      <span
        aria-hidden
        className={cn(
          'h-3.5 w-3.5 shrink-0 rounded-full',
          on ? 'border-4 border-fg' : 'border-[1.5px] border-line-strong',
        )}
      />
      {label}
    </button>
  )
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t('结束')} className="flex gap-2">
        {option(!until, t('永不'), () => onChange(''))}
        {option(until, t('到某天'), pickUntil)}
      </div>
      {until && (
        <Input
          type="date"
          aria-label={t('结束日期')}
          className={cn('tabular-nums dark:[color-scheme:dark]', compact && 'h-8')}
          value={value}
          // 清空日期框就回到「永不」：不留一个看不见的空限制
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}
