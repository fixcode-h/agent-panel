import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import * as P from '@radix-ui/react-popover'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { MenuSearch } from './menu-search'

/** 下拉列表的一项：Radix 版和带搜索的版本共用，两种列表看起来一样 */
export const listItem =
  'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-(--c-menu-itemRadius) py-1 pr-8 pl-2.5 text-left text-body leading-5 ' +
  'outline-none data-[highlighted]:bg-hover data-[state=checked]:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

export type SelectOption = { value: string; label: string; group?: string; short?: string }

/**
 * 选项多到几项以上时打开下拉带搜索框：读设置 → 组件 → 下拉菜单的「搜索框」（--c-menu-search，0 是不显示）。
 * 只在打开的那一下读一次 CSS 变量，不在每次渲染时读：页面上几十个下拉框，渲染时读会反复强制算样式
 */
export function wantSearch(count: number, force?: boolean): boolean {
  if (force !== undefined) return force
  const min = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--c-menu-search'), 10)
  return min > 0 && count >= min
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')

/** 搜索命中：显示的文字、短说法、值和组名都算（日志分类这类值和显示一样的，组名能把一整组筛出来）；空格忽略 */
export function filterOptions(options: SelectOption[], q: string): SelectOption[] {
  const k = norm(q)
  if (!k) return options
  return options.filter((o) => [o.label, o.short, o.value, o.group].some((s) => s && norm(s).includes(k)))
}

/**
 * 带搜索的下拉列表：和 Radix Select 的列表同一套样式（listItem、--c-menu-*），顶上多一个搜索框。
 * Radix Select 的列表里放不了输入框（它会抢走焦点、把打的字当成跳到某项），所以选项多时换成 Popover 自己画列表。
 * 键盘：上下键移动、回车选中、Esc 关掉；打开时高亮当前选中的那项
 */
export function SelectSearchPanel({
  open,
  onOpenChange,
  anchor,
  options,
  value,
  onPick,
  label,
  returnFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 下拉框本身（触发按钮），列表贴着它弹出 */
  anchor: ReactNode
  options: SelectOption[]
  value: string
  onPick: (v: string) => void
  /** 读屏名：列表和搜索框都用它 */
  label?: string
  /** 关上后焦点回到下拉框（没有 Popover.Trigger，Radix 不知道该还给谁） */
  returnFocus: () => void
}) {
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const list = useMemo(() => filterOptions(options, q), [options, q])

  // 每次打开都从空搜索、当前选中项开始
  useEffect(() => {
    if (!open) return
    setQ('')
    setHi(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    )
    // 只在打开那一下重置：开着时选项变了（日志分类在涨）不把高亮跳回去
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 高亮项滚进可见范围（键盘移动、打开时当前项在很下面）
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-highlighted]')?.scrollIntoView({ block: 'nearest' })
  }, [open, hi, list])

  const move = (d: number) => setHi((h) => (list.length ? (h + d + list.length) % list.length : 0))
  const pick = (v: string) => {
    onPick(v)
    onOpenChange(false)
  }

  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Anchor asChild>{anchor}</P.Anchor>
      <P.Portal>
        <P.Content
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            returnFocus()
          }}
          // 点下拉框本身由它自己开关，不当成「点到外面」，否则会先关上再被它重新打开
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement).closest?.('[data-select-search-anchor]')) e.preventDefault()
          }}
          className={cn(
            'z-50 flex max-h-[min(400px,var(--radix-popover-content-available-height))] min-w-[var(--radix-popover-trigger-width)] max-w-[min(420px,calc(100vw-2rem))] flex-col',
            'overflow-hidden rounded-(--c-menu-radius) border-(length:--c-menu-border) border-pop-edge bg-(--c-menu-bg) p-0.5 shadow-pop anim-pop',
          )}
        >
          <MenuSearch
            value={q}
            onChange={(v) => {
              setQ(v)
              setHi(0)
            }}
            placeholder={t('搜索')}
            aria-label={label ? t('搜索{label}', { label }) : t('搜索')}
            aria-controls={listId}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(e.key === 'ArrowDown' ? 1 : -1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (list[hi]) pick(list[hi].value)
              }
            }}
            className="m-0.5 mb-1"
          />
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {list.map((o, i) => [
              o.group && o.group !== list[i - 1]?.group && (
                <div
                  key={`g:${o.group}`}
                  className={cn(
                    'px-2.5 pt-1.5 pb-1 text-caption text-subtle',
                    i > 0 && 'mt-1 border-t border-line pt-2',
                  )}
                >
                  {o.group}
                </div>
              ),
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-highlighted={i === hi ? '' : undefined}
                data-state={o.value === value ? 'checked' : undefined}
                tabIndex={-1}
                onMouseMove={() => i !== hi && setHi(i)}
                onClick={() => pick(o.value)}
                className={listItem}
              >
                <span className="min-w-0 truncate">{o.short ?? o.label}</span>
                {o.value === value && <Check className="absolute right-2.5 h-3.5 w-3.5 text-accent-text" />}
              </button>,
            ])}
            {!list.length && <div className="px-2.5 py-2 text-body text-subtle">{t('没有匹配的选项')}</div>}
          </div>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
