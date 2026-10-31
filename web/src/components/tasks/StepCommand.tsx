import { SquareTerminal } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { Terminal } from '@/components/agents/CommandPreview'

/** 命令里最能说明问题的一段：程序名加前面几个不带横线的参数（提示词太长，截断显示） */
function shortCommand(argv: string[]) {
  const bin = argv[0]?.split(/[\\/]/).pop() ?? ''
  const rest = argv
    .slice(1)
    .filter((a) => !a.startsWith('-'))
    .slice(0, 2)
  return [bin, ...rest].join(' ')
}

/**
 * 启动这个节点 / 这条回复的 CLI 命令：点开看完整命令，可以复制出来自己跑。
 * 节点标题旁放不下文字，只显示图标；署名行最右边用 showText 显示命令本身。
 */
export function StepCommand({ argv, className, showText }: { argv: string[]; className?: string; showText?: boolean }) {
  if (!argv.length) return null
  return (
    <Popover>
      <PopoverTrigger
        title={t('查看启动命令')}
        aria-label={t('查看启动命令')}
        className={cn(
          'shrink-0 cursor-pointer items-center rounded-md text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel data-[state=open]:text-fg',
          showText ? 'flex min-w-0 gap-1.5 px-1.5 py-0.5 font-mono text-caption' : 'grid h-6 w-6 place-items-center',
          className,
        )}
      >
        <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
        {showText && <span className="truncate">{shortCommand(argv)}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(560px,90vw)] p-0">
        <Terminal argv={argv} title={t('启动命令')} className="rounded-[inherit] border-0" />
      </PopoverContent>
    </Popover>
  )
}
