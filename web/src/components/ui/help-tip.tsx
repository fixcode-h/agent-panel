import { CircleHelp } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Hint } from './hint'

/**
 * 设置项旁边的问号：鼠标移上去、点一下（或键盘 Tab 过来）弹出说明。
 * 只给需要解释的复杂项用，简单项不加，免得满屏都是说明文字。
 *
 * 浮层外观、定位、指针离开的收尾和 Esc 关闭都在 Hint 里，这里只负责问号这个触发元素长什么样。
 */
export function HelpTip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Hint content={children}>
      <span
        role="img"
        tabIndex={0}
        aria-label={t('说明')}
        className={cn(
          'inline-grid h-4 w-4 shrink-0 cursor-help place-items-center rounded-full text-subtle outline-none transition-colors hover:text-fg focus-visible:text-fg',
          className,
        )}
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </span>
    </Hint>
  )
}
