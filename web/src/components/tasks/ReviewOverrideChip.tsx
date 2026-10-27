import { ShieldAlert } from 'lucide-react'
import type { Task } from '@shared/schema'
import { hhmm, ymd } from '@shared/datetime'
import { t } from '@shared/i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { cn } from '@/lib/utils'
import { META_CHIP } from './chip'

/**
 * 输入框下面的「评审已放行」小块：这次收尾绕过了评审门禁。
 * 数据只来自任务上的 reviewOverride（面板接收 submit_merge 时记的），这里不提供开关：
 * 放行只能由用户或父对话要求，记录留在任务上，父对话合并前能看到。
 */
export function ReviewOverrideChip({ task }: { task: Task }) {
  const o = task.reviewOverride
  if (!o) return null
  const d = new Date(o.at)
  const at = Number.isNaN(d.getTime()) ? o.at : `${ymd(d)} ${hhmm(d)}`
  return (
    <Popover>
      <PopoverTrigger className={cn(META_CHIP, 'text-warning')} title={t('评审已放行')} aria-label={t('评审已放行')}>
        <ShieldAlert className="h-3.5 w-3.5" />
        <span>{t('评审已放行')}</span>
      </PopoverTrigger>
      <PopoverContent className="w-[min(420px,calc(100vw-24px))]">
        <dl className="flex flex-col gap-2 p-2.5 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="font-medium text-fg">{t('评审已放行')}</dt>
            <dd className="text-subtle">{t('合并前评审门禁被绕过')}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-subtle">{t('谁放行')}</dt>
            <dd className="min-w-0 text-muted">{o.by === 'user' ? t('用户') : t('父对话')}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-subtle">{t('什么时候')}</dt>
            <dd className="min-w-0 font-mono text-muted">{at}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-subtle">{t('为什么')}</dt>
            <dd className="min-w-0 break-words text-muted">{o.reason}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-subtle">{t('原本拦住的是')}</dt>
            <dd className="min-w-0 break-words text-muted">{o.blocked}</dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  )
}
