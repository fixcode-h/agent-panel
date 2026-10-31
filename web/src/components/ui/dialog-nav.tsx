import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { t } from '@shared/i18n'
import { ModalButton } from '@/components/ui/modal'
import { cn } from '@/lib/utils'

// 设置类弹窗共用的关闭按钮和左栏导航项：项目设置、全局设置、设计项目都用。
// 单独成文件，引用它们的弹窗不会把项目设置弹窗（带流程图画布）一起打进包里

/** 关闭按钮：设置类弹窗共用（Esc 也能关，悬停提示里写上） */
export function DialogCloseButton({ label = t('关闭') }: { label?: string }) {
  return (
    <D.Close asChild>
      <ModalButton icon={X} label={`${label}（Esc）`} className="[&>svg]:h-[1.125rem] [&>svg]:w-[1.125rem]" />
    </D.Close>
  )
}

export function NavItem({
  on,
  onClick,
  dot,
  hint,
  children,
}: {
  on: boolean
  onClick: () => void
  /** 有没保存的改动 */
  dot?: boolean
  /** 右边的小字：用的是哪个文件 */
  hint?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      className={cn(
        'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-body whitespace-nowrap transition-colors',
        on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
      )}
    >
      {children}
      {hint && (
        <span className="ml-auto hidden truncate font-mono text-caption font-normal text-subtle md:inline">{hint}</span>
      )}
      {dot && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-accent', !hint && 'ml-auto')}
          title={t('有未保存的改动')}
        />
      )}
    </button>
  )
}
