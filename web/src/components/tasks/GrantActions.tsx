import { Loader2 } from 'lucide-react'
import { requestRuleText } from '@shared/allow-rules'
import { rememberOn } from '@shared/grants/kinds'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 授权卡上点了哪一个：拒绝、允许一次、本对话不再询问 */
export type GrantChoice = 'deny' | 'once' | 'always'

/**
 * 授权卡的按钮（用户 2026-11-24 统一）：所有「要不要允许」的卡片都用这一组，CLI 权限请求、门禁放行、插件确认、
 * 子对话行上的快捷按钮一个样子。请求带了同一类的规则键（rule），并且设置 →「授权卡」里这一类开着，
 * 就多一个「本对话不再询问」，并把它做成主按钮（默认放行）；否则只有「拒绝 / 允许」。
 * 同一类怎么算、给不给，都在 shared/grants/kinds.ts 的注册表里
 */
export function GrantActions({
  req,
  busy,
  onPick,
  disabled,
  compact,
  className,
}: {
  req: { rule?: string; ruleLabel?: string }
  /** 正在提交的那一个（转圈，其余按钮禁用）；空串表示没在提交 */
  busy: GrantChoice | ''
  onPick: (c: GrantChoice) => void
  /** 别处在提交（子对话栏的另一行）：按钮都不能点，但不转圈 */
  disabled?: boolean
  /** 子对话行上那种小号按钮 */
  compact?: boolean
  className?: string
}) {
  const { settings } = useData()
  const remember = rememberOn(req.rule, settings?.grantRemember)
  const size = compact ? 'h-6 px-2 text-xs' : ''
  const spin = (c: GrantChoice) =>
    busy === c && <Loader2 className={cn('animate-spin', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
  const what = remember ? requestRuleText(req) : ''
  const off = !!busy || !!disabled
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2', compact && 'gap-1', className)}>
      <Button
        size="sm"
        variant="secondary"
        className={size}
        disabled={off}
        data-grant="deny"
        onClick={() => onPick('deny')}
      >
        {spin('deny')}
        {t('拒绝')}
      </Button>
      <Button
        size="sm"
        variant={remember ? 'secondary' : 'primary'}
        className={size}
        disabled={off}
        data-grant="once"
        title={remember ? t('只允许这一次，下次同类的还会问') : undefined}
        onClick={() => onPick('once')}
      >
        {spin('once')}
        {remember ? t('允许一次') : t('允许')}
      </Button>
      {remember && (
        <Button
          size="sm"
          className={size}
          disabled={off}
          data-grant="always"
          title={t('允许这一次，并且这个对话里之后的{rule}都自动允许，不再弹卡（对话里会留一行记录；新对话会重新问）', {
            rule: what,
          })}
          onClick={() => onPick('always')}
        >
          {spin('always')}
          {t('本对话不再询问')}
        </Button>
      )}
    </div>
  )
}
