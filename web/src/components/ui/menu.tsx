import * as C from '@radix-ui/react-context-menu'
import * as M from '@radix-ui/react-dropdown-menu'
import * as P from '@radix-ui/react-popover'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export const popoverPanel =
  'z-50 min-w-[220px] overflow-hidden rounded-xl border border-line-strong bg-card p-1 shadow-pop animate-[fade-in_120ms_ease-out]'
export const menuItem =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] outline-none ' +
  'data-[highlighted]:bg-sel data-[disabled]:pointer-events-none data-[disabled]:opacity-50 hover:bg-sel'

export const Menu = M.Root
export const MenuTrigger = M.Trigger

/**
 * 按坐标弹出的菜单：输入框里的卡片是命令式建出来的 DOM，没有 React 触发元素可用，只能指定鼠标位置。
 * 用 0 尺寸的固定定位元素当锚点，贴近视口边缘时 Radix 自己翻边。
 */
export function PointMenu({
  at,
  open,
  onOpenChange,
  children,
}: {
  /** 弹出位置（鼠标坐标）；null 表示还没弹出过 */
  at: { x: number; y: number } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <M.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <M.Trigger asChild>
        <span aria-hidden className="fixed h-0 w-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </M.Trigger>
      <M.Portal>
        <M.Content
          side="bottom"
          align="start"
          sideOffset={2}
          collisionPadding={8}
          className={cn(popoverPanel, 'max-w-[calc(100vw-16px)] min-w-[180px]')}
          // 关闭后默认把焦点还给锚点（0 尺寸的元素）；卡片菜单要交回输入框，由调用方给焦点
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  )
}

export function MenuContent({
  children,
  align = 'end',
  className,
}: {
  children: React.ReactNode
  align?: 'start' | 'end'
  className?: string
}) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={6} className={cn(popoverPanel, 'min-w-[160px]', className)}>
        {children}
      </M.Content>
    </M.Portal>
  )
}

export function MenuItem({ danger, className, ...props }: M.DropdownMenuItemProps & { danger?: boolean }) {
  return <M.Item className={cn(menuItem, danger && 'text-danger', className)} {...props} />
}

/**
 * 单选菜单项（侧栏的模式切换）：Radix 给上 role="menuitemradio" 和 aria-checked。
 * 勾在行尾，没选中时也占着位置，各行的说明文字才对得齐
 */
export const MenuRadioGroup = M.RadioGroup
export function MenuRadioItem({ className, children, ...props }: M.DropdownMenuRadioItemProps) {
  return (
    <M.RadioItem className={cn(menuItem, className)} {...props}>
      {children}
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
        <M.ItemIndicator>
          <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
        </M.ItemIndicator>
      </span>
    </M.RadioItem>
  )
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
      {/* 窄窗口、右栏里也放得下：和视口留 8px 边距，超过一屏时菜单自己滚动 */}
      <C.Content
        className={cn(popoverPanel, 'max-h-[calc(100dvh-16px)] min-w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto')}
        collisionPadding={8}
      >
        {children}
      </C.Content>
    </C.Portal>
  )
}

export function ContextMenuItem({ danger, className, ...props }: C.ContextMenuItemProps & { danger?: boolean }) {
  return <C.Item className={cn(menuItem, danger && 'text-danger', className)} {...props} />
}

/**
 * 带勾选框的右键菜单项：Radix 自己会给上 role="menuitemcheckbox" 和 aria-checked，读屏能读到勾没勾。
 * 未勾选时也占着左侧图标位，勾选时文字不跳
 */
export function ContextMenuCheckboxItem({ className, children, ...props }: C.ContextMenuCheckboxItemProps) {
  return (
    <C.CheckboxItem className={cn(menuItem, className)} {...props}>
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
        <C.ItemIndicator>
          <Check className="h-3.5 w-3.5" />
        </C.ItemIndicator>
      </span>
      {children}
    </C.CheckboxItem>
  )
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
