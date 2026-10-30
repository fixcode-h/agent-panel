import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: SwitchPrimitive.SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative inline-flex h-[18px] w-[34px] shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'bg-line-strong data-[state=checked]:bg-(--c-switch-on)',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[18px] dark:data-[state=checked]:bg-on-primary" />
    </SwitchPrimitive.Root>
  )
}
