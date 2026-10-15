import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'

export function AgentAvatar({ name, cli, size = 'md' }: { name: string; cli: string; size?: 'md' | 'lg' }) {
  return (
    <div
      className={cn(
        'grid shrink-0 place-items-center rounded-xl bg-gradient-to-br font-semibold text-white shadow-inner',
        cliStyle(cli).gradient,
        size === 'lg' ? 'h-14 w-14 text-xl' : 'h-10 w-10 text-base',
      )}
    >
      {name.trim().slice(0, 1).toUpperCase() || '?'}
    </div>
  )
}
