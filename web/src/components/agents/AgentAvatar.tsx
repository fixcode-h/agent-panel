import { agentIcon } from '@/lib/agent-icons'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'

const sizes = {
  sm: 'h-9 w-9 rounded-[10px] [&>svg]:h-[18px] [&>svg]:w-[18px]',
  md: 'h-11 w-11 rounded-xl [&>svg]:h-5 [&>svg]:w-5',
  lg: 'h-[52px] w-[52px] rounded-[14px] [&>svg]:h-6 [&>svg]:w-6',
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
    <div
      className={cn(
        'relative grid shrink-0 place-items-center bg-gradient-to-br text-white shadow-lg',
        'ring-1 ring-inset ring-white/20',
        cliStyle(cli).tile,
        sizes[size],
        dim && 'grayscale opacity-60',
      )}
    >
      <Icon strokeWidth={2} />
    </div>
  )
}
