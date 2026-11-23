import { Check, ChevronRight } from 'lucide-react'
import type { Ref } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import type { MenuAction, MenuItem, MenuSub } from './item-menu'

/**
 * 菜单的一列项怎么画、怎么筛：主菜单和子菜单（「移到模块 ▸」）共用同一套行，
 * 样式只在这里改一处。键盘上下选、回车执行由 menu.tsx 统一管（同一时间只有一列在接键盘）
 */

export const isAction = (it: MenuItem): it is MenuAction => typeof it === 'object' && 'onClick' in it && !it.disabled
export const isSub = (it: MenuItem): it is MenuSub => typeof it === 'object' && 'sub' in it
/** 能停上去的项：能点的，和没禁用的子菜单 */
export const isPick = (it: MenuItem) => isAction(it) || (isSub(it) && !it.disabled && tidy(it.sub).some(isAction))

/** 子菜单里的项超过这么多条就自动带搜索框（几十个模块一眼找不到） */
export const SUB_SEARCH_AT = 8

/** 去掉条件不满足的项，以及开头、结尾、连着的分隔线 */
export function tidy<T extends MenuItem>(items: (T | false | '' | undefined | null)[]): T[] {
  const list: T[] = []
  for (const it of items) {
    if (!it) continue
    if (it === 'sep' && (!list.length || list.at(-1) === 'sep')) continue
    list.push(it)
  }
  while (list.at(-1) === 'sep') list.pop()
  return list
}

/** 搜索：留下名字、说明里带关键字的项，小标题只在它下面还有项时留着 */
export function filterItems<T extends MenuItem>(items: T[], q: string): T[] {
  const k = q.trim().toLowerCase()
  if (!k) return items
  const out: T[] = []
  let title: T | undefined
  for (const it of items) {
    // 泛型参数收窄不了，按 MenuItem 判断
    const x: MenuItem = it
    if (x === 'sep') continue
    if ('title' in x) {
      title = it
      continue
    }
    if (!`${x.label} ${x.hint ?? ''}`.toLowerCase().includes(k)) continue
    if (title) out.push(title)
    title = undefined
    out.push(it)
  }
  return out
}

/** 菜单顶上的搜索框（带搜索的主菜单、长子菜单共用） */
export function MenuSearch({
  value,
  placeholder,
  onChange,
  ref,
}: {
  value: string
  placeholder: string
  onChange: (q: string) => void
  /** 子菜单定好位置才显示，autoFocus 在还看不见时不生效：由 menu.tsx 定位后再聚焦 */
  ref?: Ref<HTMLInputElement>
}) {
  return (
    <input
      ref={ref}
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="mb-1 h-7 w-full shrink-0 rounded-(--c-menu-itemRadius) border-b border-line bg-transparent px-2 text-footnote text-fg outline-none placeholder:text-subtle"
    />
  )
}

export interface RowsProps {
  items: MenuItem[]
  act: number
  /** 开着的子菜单是第几项（-1 没开） */
  open?: number
  onHover: (i: number) => void
  onPick: (it: MenuAction) => void
  /** 点子菜单那一项：马上展开（不等悬停的延时） */
  onSub?: (i: number) => void
}

/** 一列菜单项。子菜单那一项右边带 ▸，展开时保持高亮 */
export function MenuRows({ items, act, open = -1, onHover, onPick, onSub }: RowsProps) {
  if (!items.length) return <div className="px-2 py-1.5 text-caption text-subtle">{t('没有对上的')}</div>
  return items.map((it, i) => {
    if (it === 'sep') return <div key={i} className="mx-1 my-1 h-px bg-line" />
    if ('title' in it)
      return (
        <div key={i} className="truncate px-2 pt-1.5 pb-1 text-caption text-subtle">
          {it.title}
        </div>
      )
    const Icon = it.icon
    const sub = isSub(it)
    const disabled = sub ? !isPick(it) : it.disabled
    const action = sub ? undefined : it
    return (
      <button
        key={i}
        type="button"
        role="menuitem"
        data-menu-row={i}
        aria-haspopup={sub ? 'menu' : undefined}
        aria-expanded={sub ? open === i : undefined}
        disabled={disabled}
        onPointerEnter={() => onHover(i)}
        onClick={() => (sub ? onSub?.(i) : action && onPick(action))}
        className={cn(
          'flex w-full shrink-0 items-center gap-2 rounded-(--c-menu-itemRadius) px-2 py-1 text-left transition-colors duration-100 disabled:opacity-40',
          (act === i || open === i) && !disabled && 'bg-hover',
          action?.danger ? 'text-danger' : 'text-fg',
        )}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-subtle">
          {action?.checked ? (
            <Check className="h-3.5 w-3.5 text-accent" />
          ) : Icon ? (
            <Icon className={cn('h-3.5 w-3.5', action?.danger && 'text-danger')} />
          ) : null}
        </span>
        {action?.lead}
        <span className={cn('min-w-0 flex-1 truncate', action?.dim && 'opacity-50')}>{it.label}</span>
        {it.hint && (
          <span className={cn('shrink-0 pl-3 text-caption text-subtle', sub && 'max-w-32 truncate')}>{it.hint}</span>
        )}
        {sub && <ChevronRight className="-mr-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />}
      </button>
    )
  })
}
