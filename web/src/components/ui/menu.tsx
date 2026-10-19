import * as C from '@radix-ui/react-context-menu'
import * as M from '@radix-ui/react-dropdown-menu'
import * as P from '@radix-ui/react-popover'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export const popoverPanel =
  'z-50 min-w-[220px] overflow-hidden rounded-xl border border-line-strong bg-card p-1 shadow-pop animate-[fade-in_120ms_ease-out]'
export const menuItem =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] outline-none ' +
  'data-[highlighted]:bg-sel data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-sel'

export const Menu = M.Root
export const MenuTrigger = M.Trigger

export function MenuContent({ children, align = 'end' }: { children: React.ReactNode; align?: 'start' | 'end' }) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={6} className={cn(popoverPanel, 'min-w-[160px]')}>
        {children}
      </M.Content>
    </M.Portal>
  )
}

export function MenuItem({ danger, className, ...props }: M.DropdownMenuItemProps & { danger?: boolean }) {
  return <M.Item className={cn(menuItem, danger && 'text-danger', className)} {...props} />
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-line" />
}

/** 右键菜单，和下拉菜单同一套样式 */
export const ContextMenu = C.Root
export const ContextMenuTrigger = C.Trigger

export function ContextMenuContent({ children }: { children: React.ReactNode }) {
  return (
    <C.Portal>
      <C.Content className={cn(popoverPanel, 'min-w-[180px]')}>{children}</C.Content>
    </C.Portal>
  )
}

export function ContextMenuItem({ danger, className, ...props }: C.ContextMenuItemProps & { danger?: boolean }) {
  return <C.Item className={cn(menuItem, danger && 'text-danger', className)} {...props} />
}

export function ContextMenuSeparator() {
  return <C.Separator className="my-1 h-px bg-line" />
}

/** 菜单项右边的快捷键提示 */
export function MenuShortcut({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-4 font-mono text-[0.6875rem] text-subtle">{children}</span>
}

/** 右键菜单的二级菜单（例如「包裹为」下面列出各种面板） */
export const ContextMenuSub = C.Sub
export function ContextMenuSubTrigger({ className, children, ...props }: C.ContextMenuSubTriggerProps) {
  return (
    <C.SubTrigger className={cn(menuItem, 'data-[state=open]:bg-sel', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto h-3.5 w-3.5 text-subtle" />
    </C.SubTrigger>
  )
}
export function ContextMenuSubContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <C.Portal>
      <C.SubContent
        sideOffset={4}
        className={cn(popoverPanel, 'max-h-[70vh] min-w-[180px] overflow-y-auto', className)}
      >
        {children}
      </C.SubContent>
    </C.Portal>
  )
}
export const ContextMenuLabel = ({ children }: { children: React.ReactNode }) => (
  <C.Label className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] text-subtle">{children}</C.Label>
)

export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverClose = P.Close

export function PopoverContent({
  children,
  className,
  align = 'start',
  onCloseAutoFocus,
}: {
  children: React.ReactNode
  className?: string
  align?: 'start' | 'end'
  /** 关闭后默认把焦点还给触发按钮；菜单项要把焦点放到别处（输入框）时在这里拦下 */
  onCloseAutoFocus?: (e: Event) => void
}) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        onCloseAutoFocus={onCloseAutoFocus}
        sideOffset={6}
        className={cn(popoverPanel, 'w-[var(--radix-popover-trigger-width)]', className)}
      >
        {children}
      </P.Content>
    </P.Portal>
  )
}
