import { ListOrdered } from 'lucide-react'
import type { TaskMessage } from '@shared/schema'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { IconButton } from '@/components/ui/icon-button'
import { t } from '@shared/i18n'

/** 少于这么多轮时不显示：一屏就看得完，不需要目录 */
const MIN_TURNS = 3

/** 一条要求在目录里显示的那一行：第一行非空文字，太长截断 */
const firstLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 80) ?? ''

/**
 * 长对话的轮次目录：按用户发的每条要求列出来，点一条跳到那一轮（更早被折叠的段也会展开）。
 * 新的在下面，和对话的顺序一致
 */
export function TurnMenu({ msgs, onJump }: { msgs: TaskMessage[]; onJump: (msgId: string) => void }) {
  const turns = msgs.filter((m) => m.role === 'user' && !m.step && m.text.trim())
  if (turns.length < MIN_TURNS) return null
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton size="sm" tone="bare" label={t('跳到某一轮')}>
          <ListOrdered className="h-4 w-4" />
        </IconButton>
      </MenuTrigger>
      <MenuContent>
        <div className="max-h-[min(420px,60vh)] w-[min(360px,calc(100vw-32px))] overflow-y-auto">
          {turns.map((m, i) => (
            <MenuItem key={m.id} onSelect={() => onJump(m.id)}>
              <span className="w-6 shrink-0 text-right font-mono text-[0.6875rem] text-subtle tabular-nums">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{firstLine(m.text)}</span>
              <span className="shrink-0 text-[0.6875rem] text-subtle">{m.at.slice(5, 16).replace('T', ' ')}</span>
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}
