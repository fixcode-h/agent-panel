import * as M from '@radix-ui/react-dropdown-menu'
import * as P from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'

export const popoverPanel =
  'z-50 min-w-[220px] overflow-hidden rounded-xl border border-line-strong bg-card p-1 shadow-2xl animate-[fade-in_120ms_ease-out]'
export const menuItem =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none ' +
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

export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverClose = P.Close

export function PopoverContent({
  children,
  className,
  align = 'start',
}: {
  children: React.ReactNode
  className?: string
  align?: 'start' | 'end'
}) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={6}
        className={cn(popoverPanel, 'w-[var(--radix-popover-trigger-width)]', className)}
      >
        {children}
      </P.Content>
    </P.Portal>
  )
}
