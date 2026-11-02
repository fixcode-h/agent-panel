import { useSyncExternalStore, type ReactNode } from 'react'
import { Pin } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import { IconButton } from '@/components/ui/icon-button'
import { MenuItem } from '@/components/ui/menu'
import { cn } from '@/lib/utils'

/**
 * 对话页标题栏的按钮和「更多操作」菜单是同一份清单：菜单里每一项右边有个钉子，
 * 钉上的显示在标题栏（「更多操作」左边），没钉的只在菜单里。所有对话共用一份设置，记在本机。
 */
export type PinKey =
  | 'settings'
  | 'rename'
  | 'export'
  | 'exportHtml'
  | 'copy'
  | 'status'
  | 'collab'
  | 'analyze'
  | 'forceStop'
  | 'resumeLatest'
  | 'delete'
  | 'progress'
  | 'processes'
  | 'popout'
  | 'report'
  | 'session'

/**
 * 默认钉在标题栏的：状态、对话进程、任务进度、功能面板、会话栏（右栏开关不在清单里，固定在「更多操作」右边）。
 * 转成弹窗用得少，默认只放菜单里（用户要求）
 */
const DEFAULT_PINS: ReadonlySet<PinKey> = new Set<PinKey>(['status', 'processes', 'progress', 'report', 'session'])

const KEY = 'task-header-pins'
/** 只记用户改过的项（钉上 true / 取下 false），没改过的按默认：以后调默认值时老用户没碰过的项跟着变 */
type Overrides = Partial<Record<PinKey, boolean>>

function read(): Overrides {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as Overrides) : {}
  } catch {
    return {}
  }
}

let current: Overrides = read()
const listeners = new Set<() => void>()

function write(next: Overrides) {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // 隐私模式禁用本地存储时只是不记住，这次打开里照样生效
  }
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** 同一页面里可能有几个对话视图（父对话、右栏子对话）：共用一个仓库，钉一下全都跟着变 */
export function useHeaderPins() {
  const pins = useSyncExternalStore(subscribe, () => current)
  const isPinned = (k: PinKey) => pins[k] ?? DEFAULT_PINS.has(k)
  const setPinned = (k: PinKey, v: boolean) => {
    const next = { ...current }
    if (v === DEFAULT_PINS.has(k)) delete next[k]
    else next[k] = v
    write(next)
  }
  return { isPinned, setPinned }
}

export type HeaderItem = {
  key: PinKey
  icon: LucideIcon
  /** 菜单里的文字，也是标题栏按钮的读屏名 */
  label: string
  title?: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** 钉在标题栏时的样子：开关类（会话栏、右栏）和下拉（对话进程）自己画，其余是同一种图标按钮 */
  pinned?: ReactNode
}

/** 钉在标题栏的样子：没有自定义的就是一个无底的图标按钮 */
export function PinnedButton({ item }: { item: HeaderItem }) {
  if (item.pinned !== undefined) return <>{item.pinned}</>
  return (
    <IconButton
      size="sm"
      tone="bare"
      icon={item.icon}
      label={item.label}
      title={item.title}
      disabled={item.disabled}
      onClick={item.onSelect}
      className={cn('shrink-0', item.danger && 'hover:text-danger')}
    />
  )
}

/**
 * 菜单里的一行：左边是菜单项，右端一个钉子。
 * 钉子是菜单项旁边的独立按钮（不套在菜单项里，菜单项里不能再放可交互的元素）；
 * 键盘用户在菜单项上按 → 也能钉 / 取下（普通菜单项上 → 没有别的用处）
 */
export function PinMenuRow({
  item,
  pinned,
  onPin,
}: {
  item: HeaderItem
  pinned: boolean
  onPin: (v: boolean) => void
}) {
  const Icon = item.icon
  const pinLabel = pinned ? t('从标题栏取下') : t('钉在标题栏')
  return (
    <div className="group/pin relative flex items-center rounded-(--c-menu-itemRadius) hover:bg-hover">
      <MenuItem
        danger={item.danger}
        disabled={item.disabled}
        title={item.title}
        onSelect={item.onSelect}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight') return
          e.preventDefault()
          onPin(!pinned)
        }}
        className="flex-1 pr-10"
        data-pinned={pinned ? '' : undefined}
        // 菜单项的名字保持原样（别处按名字找它）；钉没钉由旁边钉子的 aria-pressed 说明，键盘按 → 切换
        aria-keyshortcuts="ArrowRight"
      >
        <Icon className="h-4 w-4" />
        {item.label}
      </MenuItem>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${pinLabel}：${item.label}`}
        title={pinLabel}
        aria-pressed={pinned}
        // 点钉子只切换，不触发菜单项、不收起菜单
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onPin(!pinned)
        }}
        className={cn(
          'absolute right-1.5 grid h-6 w-6 cursor-pointer place-items-center rounded-sm transition-opacity',
          pinned
            ? 'text-fg'
            : 'text-subtle opacity-0 group-hover/pin:opacity-100 hover:text-fg [@media(hover:none)]:opacity-100',
        )}
      >
        <Pin className={cn('h-3.5 w-3.5 rotate-45', pinned && 'fill-current')} />
      </button>
    </div>
  )
}
