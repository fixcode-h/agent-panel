import type { WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { Field, FormSection, Input } from '@/components/ui/input'
import { GrantList } from './GrantList'
import { Switch } from '@/components/ui/switch'

type Set = <K extends keyof WorkflowInput>(k: K, v: WorkflowInput[K]) => void

/**
 * 工作流详情里和「怎么跑」有关的几项：修改轮次、自带的授权、直接在父对话目录里跑。
 * 从 WorkflowDetail 拆出来（那边的函数已到结构检查的上限），自带授权（用户 2026-11-25）的列表见 GrantList
 */
export function WorkflowRunSettings({ draft, set }: { draft: WorkflowInput; set: Set }) {
  const grants = draft.grants ?? []
  return (
    <>
      <FormSection title={t('修改轮次')}>
        <p className="-mt-2 text-xs leading-relaxed text-subtle">
          {t('同一个节点被要求修改超过这么多轮时，运行结尾提示一句（不会强制停下）。0 表示不提示。')}
        </p>
        <Field label={t('最多几轮')} className="max-w-60">
          <Input
            inputMode="numeric"
            value={String(draft.reviseLimit ?? 3)}
            onChange={(e) => set('reviseLimit', Math.min(50, Number(e.target.value.replace(/[^\d]/g, '')) || 0))}
          />
        </Field>
      </FormSection>

      {(grants.length > 0 || draft.kind === 'change') && (
        <FormSection title={t('运行方式')}>
          {draft.kind === 'change' && (
            <label className="flex items-start gap-3">
              <Switch
                className="mt-0.5"
                checked={!!draft.inPlace}
                onCheckedChange={(v) => set('inPlace', v)}
                aria-label={t('直接在父对话的目录里改')}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-fg">{t('直接在父对话的目录里改')}</span>
                <span className="text-xs leading-relaxed text-subtle">
                  {t(
                    '不开独立分支。要连本机正在运行的程序验证时打开（例如 UE 编辑器读的是项目目录，独立分支里的改动它看不到）',
                  )}
                </span>
              </span>
            </label>
          )}
          <GrantList
            grants={grants}
            hint={t(
              '运行这个工作流时，下面这几类操作直接允许、不弹确认卡，对话里会留一行记录。不想自动放行的可以去掉。',
            )}
            onChange={(next) => set('grants', next)}
          />
        </FormSection>
      )}
    </>
  )
}
