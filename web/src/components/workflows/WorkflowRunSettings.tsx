import { ShieldCheck, X } from 'lucide-react'
import type { WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { Field, FormSection, Input } from '@/components/ui/input'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'

type Set = <K extends keyof WorkflowInput>(k: K, v: WorkflowInput[K]) => void

/**
 * 工作流详情里和「怎么跑」有关的几项：修改轮次、自带的授权、直接在父对话目录里跑。
 * 从 WorkflowDetail 拆出来（那边的函数已到结构检查的上限），自带授权（用户 2026-11-25）只能删不能加：
 * 加哪些由工作流的作者（插件）定，用户复制一份改的时候可以去掉不想自动放行的
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
          {grants.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">{t('自带的授权')}</span>
              <p className="text-xs leading-relaxed text-subtle">
                {t(
                  '运行这个工作流时，下面这几类操作直接允许、不弹确认卡，对话里会留一行记录。不想自动放行的可以去掉。',
                )}
              </p>
              <ul className="flex flex-col gap-1">
                {grants.map((g) => (
                  <li key={g.rule} className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{g.label || g.rule}</span>
                    <code className="truncate font-mono text-footnote text-subtle">{g.rule}</code>
                    <IconButton
                      icon={X}
                      size="xs"
                      label={t('去掉这条授权')}
                      onClick={() => {
                        const next = grants.filter((x) => x.rule !== g.rule)
                        set('grants', next)
                      }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </FormSection>
      )}
    </>
  )
}
