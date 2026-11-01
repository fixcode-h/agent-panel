import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: SwitchPrimitive.SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'group/sw relative inline-flex h-[18px] w-[34px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-(--dur-base) ease-(--ease-snap)',
        'bg-line-strong data-[state=checked]:bg-(--c-switch-on)',
        className,
      )}
      {...props}
    >
      {/* 滑块用弹簧曲线移动；按住时拉长 4px（选中时往左长，右边贴住不动），松手弹回 */}
      <SwitchPrimitive.Thumb className="block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[translate,width] duration-(--dur-base) ease-(--ease-spring) group-active/sw:w-[1.125rem] data-[state=checked]:translate-x-[18px] group-active/sw:data-[state=checked]:translate-x-[14px] dark:data-[state=checked]:bg-on-primary" />
    </SwitchPrimitive.Root>
  )
}
