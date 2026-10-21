import { subAgentIds } from '@shared/flow'
import { Check, ChevronDown, Workflow as WorkflowIcon } from 'lucide-react'
import { useData } from '@/lib/data'
import { t } from '@shared/i18n'
import { isReady, workflowChecks } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { fieldClass } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'

/** 选择工作流；`emptyLabel` 是不选时显示的文字，例如「使用分类默认」 */
export function WorkflowPicker({
  value,
  onChange,
  emptyLabel,
}: {
  value: string
  onChange: (id: string) => void
  emptyLabel: string
}) {
  const { workflows, agents, clis } = useData()
  const current = workflows.find((w) => w.id === value)
  const mainName = (id: string) => agents.find((a) => a.id === id)?.name ?? t('直接用 Agent')
  return (
    <Popover>
      <PopoverTrigger className={cn(fieldClass, 'flex h-10 cursor-pointer items-center gap-2 text-left')}>
        <WorkflowIcon className="h-4 w-4 text-subtle" />
        <span className={cn('flex-1 truncate', !current && 'text-subtle')}>{current?.name ?? emptyLabel}</span>
        <ChevronDown className="h-4 w-4 text-subtle" />
      </PopoverTrigger>
      <PopoverContent>
        <div className="max-h-72 overflow-y-auto">
          <PopoverClose className={menuItem} onClick={() => onChange('')}>
            <span className="flex-1 text-muted">{emptyLabel}</span>
            {!value && <Check className="h-4 w-4 text-accent" />}
          </PopoverClose>
          {workflows.map((w) => (
            <PopoverClose key={w.id} className={menuItem} onClick={() => onChange(w.id)}>
              <span
                title={isReady(workflowChecks(w, agents, clis, workflows)) ? t('就绪') : t('未就绪')}
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  isReady(workflowChecks(w, agents, clis, workflows)) ? 'bg-success' : 'bg-warning',
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{w.name}</span>
                <span className="truncate text-xs text-subtle">
                  {mainName(w.mainAgentId)} · {t('{n} 个子角色', { n: subAgentIds(w).length })}
                </span>
              </span>
              {w.id === value && <Check className="h-4 w-4 text-accent" />}
            </PopoverClose>
          ))}
          {workflows.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有工作流，先去工作流页面创建')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
