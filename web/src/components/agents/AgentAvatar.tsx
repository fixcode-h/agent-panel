import { agentIcon } from '@/lib/agent-icons'
import { cliColor } from '@/lib/cli-style'
import { cn } from '@/lib/utils'

const sizes = {
  xs: 'h-[22px] w-[22px] rounded-md [&>svg]:h-3 [&>svg]:w-3',
  sm: 'h-[26px] w-[26px] rounded-[7px] [&>svg]:h-3.5 [&>svg]:w-3.5',
  md: 'h-9 w-9 rounded-[9px] [&>svg]:h-[18px] [&>svg]:w-[18px]',
  lg: 'h-12 w-12 rounded-xl [&>svg]:h-6 [&>svg]:w-6',
}

/** Agent 头像：底色代表 CLI，图标代表职责 */
export function AgentAvatar({
  icon,
  cli,
  size = 'md',
  dim,
}: {
  icon: string
  cli: string
  size?: keyof typeof sizes
  dim?: boolean
}) {
  const Icon = agentIcon(icon)
  return (
    <span
      className={cn('grid shrink-0 place-items-center text-white', sizes[size], dim && 'opacity-50 grayscale')}
      style={{ background: cliColor(cli) }}
    >
      <Icon strokeWidth={1.8} />
    </span>
  )
}
