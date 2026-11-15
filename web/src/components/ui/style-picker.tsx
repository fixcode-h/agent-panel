import { useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import type { SavedStyle, StyleKind } from '@shared/style-types'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { Popover, PopoverContent, PopoverTrigger } from './menu'
import { MenuSearch } from './menu-search'
import { StyleThumb, styleImageSrc } from './style-thumb'

/**
 * 选一个风格（风格库里某一类的风格）：触发处是一个带缩略图的小标签「风格：通用」，点开是列表。
 * 列表每行左边是参考图缩略图（点它看大图，不会选中），右边名字和说明（点它选中）。
 * 风格列表由调用方给（styles，自己存的在前、内置的在后），组件不自己请求，设置 →「控件样式」的样张也能直接用
 */
export function StylePicker({
  styles,
  value,
  onChange,
  kind,
  disabled,
  busy,
  align = 'start',
}: {
  /** 风格库（还在加载时传 null） */
  styles: SavedStyle[] | null
  /** 选中的风格 id */
  value: string
  onChange: (s: SavedStyle) => void
  /** 只列这一类 */
  kind: StyleKind
  disabled?: boolean
  /** 正在保存（换风格请求还没回来）：标签上转圈 */
  busy?: boolean
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const list = (styles ?? []).filter((s) => s.kind === kind)
  const ordered = [...list.filter((s) => !s.builtin), ...list.filter((s) => s.builtin)]
  const cur = list.find((s) => s.id === value)
  const kw = q.trim().toLowerCase()
  const shown = ordered.filter((s) => !kw || `${s.name} ${s.summary}`.toLowerCase().includes(kw))
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQ('')
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={t('风格：{name}', { name: cur?.name ?? t('未选') })}
        className="inline-flex h-8 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-(--c-chip-radius) bg-field pr-2 pl-1 text-footnote text-muted transition-colors hover:text-fg disabled:cursor-default disabled:opacity-60 data-[state=open]:text-fg"
      >
        {cur ? (
          <span className="h-6 w-[38px] shrink-0 overflow-hidden rounded-(--c-styleRef-radius) bg-sel">
            <StyleThumbImg style={cur} />
          </span>
        ) : null}
        <span className="text-subtle">{t('风格')}</span>
        <span className="min-w-0 truncate font-medium text-fg">{cur?.name ?? t('未选')}</span>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[360px] p-0">
        <div className="border-b px-1.5 py-1.5">
          <MenuSearch value={q} onChange={setQ} placeholder={t('搜索风格')} className="mb-0 h-7" />
        </div>
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-1" role="listbox" aria-label={t('风格')}>
          {!styles ? (
            <Loader2 className="mx-auto my-4 h-4 w-4 animate-spin text-subtle" />
          ) : (
            shown.map((s) => (
              <StyleOption
                key={s.id}
                s={s}
                on={s.id === value}
                onPick={() => {
                  onChange(s)
                  setOpen(false)
                }}
              />
            ))
          )}
          {styles && !shown.length && <p className="px-2.5 py-2 text-footnote text-subtle">{t('没有匹配的风格')}</p>}
        </div>
        <p className="border-t px-3 py-2 text-caption leading-relaxed text-subtle">
          {t('点缩略图看参考图。风格在设置 →「风格」里能复制后微调。')}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** 列表里的一行：缩略图（看大图）+ 名字和说明（选中） */
export function StyleOption({ s, on, onPick }: { s: SavedStyle; on: boolean; onPick: () => void }) {
  return (
    <div
      role="option"
      aria-selected={on}
      className={cn(
        'flex items-start gap-2.5 rounded-(--c-menu-itemRadius) px-1.5 py-1.5',
        on ? 'bg-sel ring-1 ring-(--c-styleRef-ring)/60' : 'hover:bg-hover',
      )}
    >
      <StyleThumb style={s} size="sm" />
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 cursor-pointer flex-col text-left">
        <span className="flex items-center gap-1.5 text-body text-fg">
          <span className="truncate">{s.name}</span>
          {s.builtin && (
            <span className="chip-lift shrink-0 rounded-sm bg-field px-1 text-micro text-subtle">{t('内置')}</span>
          )}
          {on && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-(--c-styleRef-ring)" />}
        </span>
        {s.summary && <span className="line-clamp-2 text-caption leading-snug text-subtle">{s.summary}</span>}
      </button>
    </div>
  )
}

/** 触发标签里的小图：只显示，不能点（点标签是打开列表） */
function StyleThumbImg({ style }: { style: SavedStyle }) {
  const src = styleImageSrc(style)
  return src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : null
}
