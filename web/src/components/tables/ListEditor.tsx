import { useMemo, useRef, useState } from 'react'
import * as P from '@radix-ui/react-popover'
import { Plus, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { EnumOption } from '@shared/table-struct'
import { cn } from '@/lib/utils'
import { popoverPanel } from '@/components/ui/menu'
import type { CellMove } from './CellEditor'

/**
 * repeated 列（一格里存一串值，用分隔符隔开）的编辑：下面列出已有的值，能删，
 * 输入框里打字回车加一项（退格删最后一项）；是枚举或引用时列出能选的值点一下加进去。确认后按项目的分隔符拼回一格
 */
export function ListEditor({
  init,
  sep,
  options,
  title,
  onDone,
}: {
  init: string
  sep: string
  /** 能选的值（枚举 / 引用）；普通的数字、文字列不传 */
  options?: EnumOption[]
  title: string
  onDone: (v: string | null, move?: CellMove) => void
}) {
  const [items, setItems] = useState(() =>
    init
      .split(sep)
      .map((x) => x.trim())
      .filter(Boolean),
  )
  const [q, setQ] = useState('')
  const ended = useRef(false)
  const end = (v: string | null, move?: CellMove) => {
    if (ended.current) return
    ended.current = true
    onDone(v, move)
  }
  const commit = (move?: CellMove) => end([...items, ...(q.trim() ? [q.trim()] : [])].join(sep), move)
  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () =>
      (options ?? [])
        .filter((o) => !needle || o.name.toLowerCase().includes(needle) || o.desc?.toLowerCase().includes(needle))
        .slice(0, 100),
    [options, needle],
  )
  const add = (v: string) => {
    if (v) setItems((xs) => [...xs, v])
    setQ('')
  }
  return (
    <P.Root open>
      <P.Anchor asChild>
        <input
          autoFocus
          aria-label={t('添加一项')}
          value={q}
          placeholder={items.join(sep)}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Escape') return void (e.preventDefault(), end(null))
            if (e.key === 'Backspace' && !q && items.length) return void setItems((xs) => xs.slice(0, -1))
            if (e.key === 'Enter' && q.trim()) {
              e.preventDefault()
              return add(options?.length && shown.length ? shown[0].name : q.trim())
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              commit(e.key === 'Tab' ? (e.shiftKey ? 'left' : 'right') : e.shiftKey ? 'up' : 'down')
            }
          }}
          className="absolute inset-0 z-3 border-0 bg-(--sheet-bg) px-2 font-[inherit] text-[length:inherit] text-fg shadow-[inset_0_0_0_2px_var(--accent)] outline-none placeholder:text-subtle"
        />
      </P.Anchor>
      <P.Portal>
        <P.Content
          side="bottom"
          align="start"
          sideOffset={2}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          className={cn(popoverPanel, 'w-[300px] p-2')}
        >
          <div className="mb-1.5 flex items-center gap-2 text-caption text-subtle">
            <span className="font-mono">{title}</span>
            <span className="ml-auto">{t('分隔符 {sep}', { sep })}</span>
          </div>
          <div className="flex flex-wrap gap-1" role="list" aria-label={t('列表里的值')}>
            {items.map((v, i) => (
              <span
                key={`${i}:${v}`}
                role="listitem"
                className="flex h-6 items-center gap-1 rounded-(--c-chip-radius) bg-sel pr-0.5 pl-2 font-mono text-footnote"
              >
                {v}
                <button
                  type="button"
                  aria-label={t('删掉 {v}', { v })}
                  onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
                  className="grid h-5 w-5 cursor-pointer place-items-center rounded-sm text-subtle hover:bg-active hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {!items.length && <span className="text-footnote text-subtle">{t('还没有值，在上面输入后回车')}</span>}
          </div>
          {!!options?.length && (
            <div className="mt-2 max-h-[200px] overflow-y-auto border-t pt-1">
              {shown.map((o) => (
                <button
                  key={o.name}
                  type="button"
                  onClick={() => add(o.name)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-(--c-menu-itemRadius) px-2 py-1 text-left text-body hover:bg-hover"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="min-w-0 truncate font-mono text-footnote">{o.name}</span>
                  {o.desc && <span className="ml-auto min-w-0 truncate text-caption text-subtle">{o.desc}</span>}
                </button>
              ))}
            </div>
          )}
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
