import { t } from '@shared/i18n'
import type { ProjectInput } from '@shared/schema'
import { Field, Input } from '@/components/ui/input'

type Budget = NonNullable<ProjectInput['budget']>

/**
 * 项目设置「用量上限」：每个顶层对话连同名下子对话合起来的 token / 费用上限（见 shared/budget.ts）。
 * token 按百万填：上限一般是几百万到几千万，填整数 token 数位太多容易少打一个零
 */
export function BudgetField({ value, onChange }: { value: ProjectInput['budget']; onChange: (v: Budget) => void }) {
  const cur: Budget = value ?? { tokens: 0, costUsd: 0 }
  const num = (s: string) => Math.max(0, Number(s) || 0)
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label={t('token 上限（百万）')}
        tip={t(
          '每个顶层对话连同名下全部子对话合起来算（输入 + 输出）。用到 80% 时在对话里提醒一次，用满时停下整个对话；之后你再发消息会接着跑一轮。0 或留空表示不限。',
        )}
      >
        <Input
          type="number"
          min={0}
          step={0.1}
          value={cur.tokens ? +(cur.tokens / 1e6).toFixed(2) : ''}
          placeholder={t('不限')}
          aria-label={t('token 上限（百万）')}
          onChange={(e) => onChange({ ...cur, tokens: Math.round(num(e.target.value) * 1e6) })}
        />
      </Field>
      <Field
        label={t('费用上限（美元）')}
        tip={t('按 Agent 报的费用累计，不报费用的 Agent 不计入。0 或留空表示不限。')}
      >
        <Input
          type="number"
          min={0}
          step={0.5}
          value={cur.costUsd || ''}
          placeholder={t('不限')}
          aria-label={t('费用上限（美元）')}
          onChange={(e) => onChange({ ...cur, costUsd: num(e.target.value) })}
        />
      </Field>
    </div>
  )
}
