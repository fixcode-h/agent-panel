import { Gauge } from 'lucide-react'
import type { ConvBudget } from '@shared/task-runtime-schema'
import { getCli } from '@shared/clis'
import { matchModel } from '@shared/model-catalog'
import { t } from '@shared/i18n'
import { useModelCatalog } from '@/lib/model-catalog'
import { cn } from '@/lib/utils'
import { Field, Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'

const fmtM = (n: number) => +(n / 1e6).toFixed(2)

/**
 * 这个模型的费用算不算得出来（分析稿 A6 ③）：CLI 自己报费用（定义里的 cost），或者模型目录里填了单价。
 * 都没有时费用一直是 0，「费用上限」永远到不了，界面要直说，免得用户以为设了就管用
 */
export function useCostKnown(cli: string, model: string): boolean {
  const catalog = useModelCatalog()
  if (getCli(cli)?.cost) return true
  return !!(model && matchModel(model, { entries: catalog?.entries ?? [] })?.entry?.price)
}

/** 没填单价时费用上限旁边那一句 */
export const NO_COST_NOTE = () => t('这个模型算不了费用，只有 token 上限生效')

/**
 * 新建对话时单独设用量上限（分析稿 A6 ①，ADR 0051 待办「单个对话自己的用量上限」）：连同名下子对话合起来算，
 * 设了就用它、不用项目设置的（shared/budget.ts 的 budgetFor）。和其他开关一样只放图标，设了以后显示上限
 */
export function ConvBudgetChip({
  value,
  onChange,
  cli,
  model,
  projectBudget,
  chip,
}: {
  value: ConvBudget
  onChange: (v: ConvBudget) => void
  /** 这个对话用的 CLI 和模型：判断费用算不算得出来 */
  cli: string
  model: string
  /** 项目设的上限：没单独设时照它算，写在说明里 */
  projectBudget?: ConvBudget
  /** 输入框工具条按钮的样式（TaskComposer 的 chip），从外面传进来免得两个文件互相引用 */
  chip: string
}) {
  const known = useCostKnown(cli, model)
  const num = (s: string) => Math.max(0, Number(s) || 0)
  const set = value.tokens > 0 || value.costUsd > 0
  const label = [value.tokens > 0 ? `${fmtM(value.tokens)}M` : '', value.costUsd > 0 ? `$${value.costUsd}` : '']
    .filter(Boolean)
    .join(' · ')
  const proj =
    projectBudget && (projectBudget.tokens > 0 || projectBudget.costUsd > 0)
      ? [
          projectBudget.tokens > 0 ? t('{n}M token', { n: fmtM(projectBudget.tokens) }) : '',
          projectBudget.costUsd > 0 ? `$${projectBudget.costUsd}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  return (
    <Popover>
      <PopoverTrigger
        className={cn(chip, !set && 'w-8 justify-center px-0', set ? 'text-accent-text' : 'text-subtle')}
        aria-label={t('这个对话的用量上限')}
        title={
          set
            ? t('这个对话的用量上限：{v}（连同名下子对话）', { v: label })
            : t('给这个对话单独设用量上限（连同名下子对话）')
        }
      >
        <Gauge className="h-4 w-4 shrink-0" />
        {set && <span className="font-mono text-xs">{label}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-[300px]" align="start">
        <div className="flex flex-col gap-3 p-2" data-conv-budget>
          <div className="flex flex-col gap-1">
            <span className="text-body font-medium text-fg">{t('这个对话的用量上限')}</span>
            <span className="text-xs leading-relaxed text-subtle">
              {proj
                ? t('连同名下子对话合起来算。设了就用这里的，不用项目设的（{v}）。80% 时提醒一次，用满时停下。', {
                    v: proj,
                  })
                : t('连同名下子对话合起来算。80% 时提醒一次，用满时停下。留空表示不限。')}
            </span>
          </div>
          <Field label={t('token 上限（百万）')}>
            <Input
              type="number"
              min={0}
              step={0.1}
              value={value.tokens ? fmtM(value.tokens) : ''}
              placeholder={t('不限')}
              aria-label={t('token 上限（百万）')}
              onChange={(e) => onChange({ ...value, tokens: Math.round(num(e.target.value) * 1e6) })}
            />
          </Field>
          <Field label={t('费用上限（美元）')}>
            <Input
              type="number"
              min={0}
              step={0.5}
              value={value.costUsd || ''}
              placeholder={t('不限')}
              aria-label={t('费用上限（美元）')}
              onChange={(e) => onChange({ ...value, costUsd: num(e.target.value) })}
            />
          </Field>
          {!known && (
            <p className="text-xs leading-relaxed text-warning" data-no-cost>
              {NO_COST_NOTE()}
              {t('（在「设置 · Agent」的模型里填了单价才按 token 折算）')}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
