import * as T from '@radix-ui/react-tooltip'
import { CircleHelp } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/**
 * 焦点是不是 Tab 走过来的。
 * Radix 的 trigger 一收到 focus 就打开说明，但弹窗、下拉、参数面板打开时会把焦点自动挪到第一个可聚焦
 * 元素上，参数区里那个元素正好是问号，于是说明浮层自己弹出来（用户没碰过它）。
 * Tab 的默认动作在同一个任务里就移完焦点，所以下一个任务清掉标记，程序化聚焦不会被当成键盘操作。
 */
let tabFocus = false
let tabTracked = false
function trackTabFocus() {
  if (tabTracked) return
  tabTracked = true
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab') return
      tabFocus = true
      setTimeout(() => {
        tabFocus = false
      }, 0)
    },
    true,
  )
}

/**
 * 设置项旁边的问号：鼠标移上去、点一下（或键盘 Tab 过来）弹出说明。
 * 只给需要解释的复杂项用，简单项不加，免得满屏都是说明文字
 */
export function HelpTip({ children, className }: { children: React.ReactNode; className?: string }) {
  // 受控：点问号也要能打开，而 Radix 的 tooltip 只有 hover 和 focus 两条路
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef(0)
  useEffect(trackTabFocus, [])

  const cancelLeave = useCallback(() => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = 0
  }, [])
  useEffect(() => cancelLeave, [cancelLeave])

  // Radix 靠 grace area 里的 pointermove 关掉浮层：鼠标一下跳开、之后就停在那儿时，那个事件收不到，
  // 浮层会留在屏幕上。所以离开问号 / 浮层后等一会儿，指针不在问号也不在浮层上就自己关。
  const scheduleClose = useCallback(() => {
    cancelLeave()
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = 0
      if (!triggerRef.current?.matches(':hover') && !contentRef.current?.matches(':hover')) setOpen(false)
    }, 250)
  }, [cancelLeave])

  return (
    <T.Provider delayDuration={150}>
      <T.Root open={open} onOpenChange={setOpen}>
        <T.Trigger asChild>
          <span
            ref={triggerRef}
            role="img"
            tabIndex={0}
            aria-label={t('说明')}
            // 弹窗自动挪过来的焦点不是用户要看说明：preventDefault 会让 Radix 的 onFocus 不再打开
            onFocus={(e) => {
              if (!tabFocus) e.preventDefault()
            }}
            // Radix 在 pointerdown 里先关掉已经打开的说明，点一下再打开会闪一下，这里不让它关
            onPointerDown={(e) => e.preventDefault()}
            onPointerLeave={scheduleClose}
            onClick={(e) => {
              // 放在可点的标签里时，点问号不触发外面的勾选、展开
              e.preventDefault()
              e.stopPropagation()
              setOpen(true)
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
            ref={contentRef}
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            onPointerEnter={cancelLeave}
            onPointerLeave={scheduleClose}
            className="z-50 max-w-[320px] rounded-lg border border-line-strong bg-card px-3 py-2 text-xs leading-relaxed text-muted shadow-pop"
          >
            {children}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  )
}
