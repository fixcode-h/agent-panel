import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'

/**
 * 审阅弹窗（ReviewDialog）多出来的两个小部件，拆出来免得主函数再变长：
 * 顶栏的「报告 / 对比上一份」切换，底栏的「不认同」按钮（诊断报告，用户 2026-11-13 定）
 */

/** 「报告 / 对比上一份」：这一版有上一份可比时才画 */
export function CompareSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Segmented
      size="sm"
      value={on ? 'cmp' : 'doc'}
      onChange={(v) => onChange(v === 'cmp')}
      label={t('看报告还是对比')}
      options={[
        { id: 'doc', label: t('报告') },
        { id: 'cmp', label: t('对比上一份') },
      ]}
      className="shrink-0"
    />
  )
}

/** 「不认同」：和「修改」一样要先有标注或意见，交回去的意思是推翻 */
export function RejectButton({
  label,
  hint,
  ready,
  busy,
  disabled,
  onClick,
}: {
  label: string
  hint: string
  /** 有标注或整体意见 */
  ready: boolean
  busy: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled || !ready}
      title={ready ? hint : t('先标注哪里不认同，或写整体意见')}
      onClick={onClick}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {label}
    </Button>
  )
}
