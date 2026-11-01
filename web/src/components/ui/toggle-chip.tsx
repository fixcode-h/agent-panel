import { Switch } from './switch'
import { cn } from '@/lib/utils'

/**
 * 带开关的小块：左边开关管「有没有」，右边名字点了「看这一份」（技能页的「装在 Claude Code / Codex」）。
 * 当前看的那一份用选中底色标出来；没打开的名字点不了（还没有那一份可看）。
 * 照 MCP 页每个 Agent 一个开关的做法，一眼看出装在哪几个 Agent 里，开关就是装 / 卸
 */
export function ToggleChip({
  label,
  checked,
  onCheckedChange,
  active,
  onPick,
  disabled,
  dot,
  title,
}: {
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
  /** 当前正在看的这一份 */
  active?: boolean
  /** 点名字：切过去看这一份（只在打开时可点） */
  onPick?: () => void
  disabled?: boolean
  /** 名字前的标识色（CLI 的颜色） */
  dot?: string
  /** 悬停说明 */
  title?: string
}) {
  const pickable = checked && !!onPick && !active
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-lg pr-2.5 pl-2 text-body transition-colors',
        active ? 'bg-sel text-fg' : 'bg-hover text-muted',
      )}
    >
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className="disabled:cursor-not-allowed disabled:opacity-50"
      />
      <button
        type="button"
        disabled={!pickable}
        onClick={onPick}
        aria-current={active || undefined}
        className={cn(
          'inline-flex items-center gap-1.5 disabled:cursor-default',
          pickable && 'cursor-pointer hover:text-fg',
          !checked && 'text-subtle',
        )}
      >
        {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />}
        {label}
      </button>
    </span>
  )
}
