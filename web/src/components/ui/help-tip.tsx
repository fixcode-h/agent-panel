import * as T from '@radix-ui/react-tooltip'
import { CircleHelp } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/**
 * 设置项旁边的问号：鼠标移上去（或键盘聚焦）弹出说明。
 * 只给需要解释的复杂项用，简单项不加，免得满屏都是说明文字
 */
export function HelpTip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <T.Provider delayDuration={150}>
      <T.Root>
        <T.Trigger asChild>
          <span
            role="img"
            tabIndex={0}
            aria-label={t('说明')}
            // 放在可点的标签里时，点问号不触发外面的勾选、展开
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            className={cn(
              'inline-grid h-4 w-4 shrink-0 cursor-help place-items-center rounded-full text-subtle outline-none transition-colors hover:text-fg focus-visible:text-fg',
              className,
            )}
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </span>
        </T.Trigger>
        <T.Portal>
          <T.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 max-w-[320px] rounded-lg border border-line-strong bg-card px-3 py-2 text-xs leading-relaxed text-muted shadow-pop"
          >
            {children}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  )
}
