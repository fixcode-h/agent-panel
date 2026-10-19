import { Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import { openAiFix, type FixIssue } from '@/lib/ai-fix'
import { Button, type ButtonProps } from './button'

/**
 * 报错旁边的「AI 处理」：把报错、命令、输出和相关情况交给 AI 分析解决，过程在统一的弹窗里看。
 * issue 可以是函数，点的时候再取最新的输出
 */
export function AiFixButton({
  issue,
  label = t('AI 处理'),
  size = 'sm',
  variant = 'secondary',
  ...props
}: Omit<ButtonProps, 'onClick'> & { issue: FixIssue | (() => FixIssue); label?: string }) {
  return (
    <Button
      size={size}
      variant={variant}
      title={t('把报错交给 AI 分析并解决')}
      aria-label={label}
      onClick={() => openAiFix(typeof issue === 'function' ? issue() : issue)}
      {...props}
    >
      <Sparkles className="h-3.5 w-3.5" />
      {size !== 'icon' && size !== 'icon-sm' && label}
    </Button>
  )
}
