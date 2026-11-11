import { useEffect, useMemo, useRef, useState } from 'react'
import * as P from '@radix-ui/react-popover'
import { Check, Plus } from 'lucide-react'
import { t } from '@shared/i18n'
import type { EnumOption } from '@shared/table-struct'
import { cn } from '@/lib/utils'
import { popoverPanel } from '@/components/ui/menu'
import type { CellMove } from './CellEditor'

/** 列表最多画这么多项（枚举表可能几千个值，搜一下就出来） */
const SHOW = 300

/**
 * 枚举 / 引用列的编辑：格子里是搜索框，下面弹出能选的值（名字、值、说明），方向键挑、回车选。
 * 打的字不在列表里时最后一项是「新增枚举值」：记进项目的表格结构文件，不写进表格本身。
 * 引用列（onAdd 不传）只能选引用的表里已有的值。
 */
export function EnumPicker({
  init,
  options,
  title,
  onDone,
  onAdd,
}: {
  init: string
  options: EnumOption[]
  /** 列表顶上的一行：枚举名或引用的表 */
  title: string
  onDone: (v: string | null, move?: CellMove) => void
  /** 新增枚举值；不传就不能新增 */
  onAdd?: (name: string) => void
}) {
  const [q, setQ] = useState(init)
  const [typed, setTyped] = useState(false)
  const [hi, setHi] = useState(0)
  const ended = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const end = (v: string | null, move?: CellMove) => {
    if (ended.current) return
    ended.current = true
    onDone(v, move)
  }
  // 刚打开时列出全部（当前值高亮）；打了字才筛
  const needle = typed ? q.trim().toLowerCase() : ''
  const shown = useMemo(
    () =>
      options
        .filter(
          (o) =>
            !needle ||
            o.name.toLowerCase().includes(needle) ||
            o.value?.toLowerCase().includes(needle) ||
            o.desc?.toLowerCase().includes(needle),
        )
        .slice(0, SHOW),
    [options, needle],
  )
  const exact = options.some((o) => o.name === q.trim() || o.value === q.trim())
  const canAdd = !!onAdd && typed && !!q.trim() && !exact
  const count = shown.length + (canAdd ? 1 : 0)
  useEffect(() => {
    if (typed) return setHi(0)
    const i = shown.findIndex((o) => o.name === init || o.value === init)
    setHi(Math.max(0, i))
    // 只在打开时和开始打字时定位
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [typed])
  useEffect(() => {
    list.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [hi])
  const pick = (i: number, move?: CellMove) => {
    if (i < shown.length) return end(shown[i].name, move)
    if (canAdd) {
      onAdd!(q.trim())
      end(q.trim(), move)
    }
  }
  return (
    <P.Root open>
      <P.Anchor asChild>
        <input
          autoFocus
          aria-label={t('选择值')}
          role="combobox"
          aria-expanded
          aria-controls="enum-picker-list"
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value)
            setTyped(true)
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => end(null)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Escape') return void (e.preventDefault(), end(null))
            if (e.key === 'ArrowDown') return void (e.preventDefault(), setHi((h) => Math.min(count - 1, h + 1)))
            if (e.key === 'ArrowUp') return void (e.preventDefault(), setHi((h) => Math.max(0, h - 1)))
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              const move = e.key === 'Tab' ? (e.shiftKey ? 'left' : 'right') : e.shiftKey ? 'up' : 'down'
              // 清空了就是把格子清空
              if (!q.trim()) return end('', move)
              if (count) return pick(hi, move)
              return end(null)
            }
          }}
          className="absolute inset-0 z-3 border-0 bg-(--sheet-bg) px-2 font-[inherit] text-[length:inherit] text-fg shadow-[inset_0_0_0_2px_var(--accent)] outline-none"
        />
      </P.Anchor>
      <P.Portal>
        <P.Content
          side="bottom"
          align="start"
          sideOffset={2}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // 点列表不让输入框失焦（失焦就算放弃）
          onMouseDown={(e) => e.preventDefault()}
          className={cn(popoverPanel, 'w-[280px] p-1')}
        >
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5 text-caption text-subtle">
            <span className="min-w-0 truncate font-mono">{title}</span>
            <span className="ml-auto shrink-0 tabular-nums">{options.length}</span>
          </div>
          <div ref={list} id="enum-picker-list" role="listbox" className="max-h-[260px] overflow-y-auto">
            {shown.map((o, i) => (
              <div
                key={o.name}
                data-i={i}
                role="option"
                aria-selected={i === hi}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(i)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-(--c-menu-itemRadius) px-2.5 py-1.5 text-body',
                  i === hi && 'bg-hover',
                )}
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0 text-accent', o.name !== init && o.value !== init && 'invisible')}
                />
                <span className="min-w-0 truncate font-mono text-footnote">{o.name}</span>
                {o.value !== undefined && o.value !== o.name && (
                  <span className="shrink-0 font-mono text-caption text-subtle">{o.value}</span>
                )}
                {o.desc && <span className="ml-auto min-w-0 truncate text-caption text-subtle">{o.desc}</span>}
              </div>
            ))}
            {!shown.length && !canAdd && <p className="px-2.5 py-2 text-footnote text-subtle">{t('没有匹配的值')}</p>}
            {canAdd && (
              <div
                data-i={shown.length}
                role="option"
                aria-selected={hi === shown.length}
                onMouseEnter={() => setHi(shown.length)}
                onClick={() => pick(shown.length)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-(--c-menu-itemRadius) border-t px-2.5 py-1.5 text-body text-accent-text',
                  hi === shown.length && 'bg-hover',
                )}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                {t('新增枚举值「{v}」', { v: q.trim() })}
              </div>
            )}
          </div>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
