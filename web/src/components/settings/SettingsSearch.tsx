import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { CornerDownLeft, Search, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { hotkeyLabel, isMac } from '@/lib/hotkey'
import { fieldClass } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { highlightParts, snippet, type SettingsItem } from '@/lib/settings-search'

/**
 * 设置页的搜索：左栏顶部的搜索框，和输入后内容区显示的结果列表。
 * 跨所有页搜设置项的标题、说明和小节名（索引见 scripts/lib/settings-index.mjs），点结果切到那一页并定位到那一行。
 */

export function SettingsSearchBox({
  value,
  onChange,
  onKeyDown,
  inputRef,
}: {
  value: string
  onChange: (v: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <label className="relative block w-[180px] shrink-0 md:mb-2 md:w-auto">
      <span className="sr-only">{t('搜索设置')}</span>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
      <input
        ref={inputRef}
        // data-settings-search：设置弹窗按 Esc 时，搜索框里有字就先清空、不关弹窗（SettingsDialog）
        data-settings-search=""
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('搜索设置')}
        spellCheck={false}
        autoComplete="off"
        className={cn(fieldClass, 'peer h-8 pr-14 pl-8 text-[0.8125rem]')}
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          aria-label={t('清空搜索')}
          className="absolute top-1/2 right-1.5 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-subtle transition-colors hover:bg-sel hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        // 聚焦后提示就没用了，收起来免得压着光标后面的位置
        <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 peer-focus:hidden">
          {hotkeyLabel(isMac ? 'Meta+F' : 'Ctrl+F')}
        </Kbd>
      )}
    </label>
  )
}

/** 结果按左栏的页分组，组头是页名（CLI 的页写成「Agent › Codex」） */
export interface SettingsHitGroup {
  section: string
  label: string
  icon: ReactNode
  items: SettingsItem[]
}

export function SettingsSearchResults({
  groups,
  terms,
  query,
  active,
  onActive,
  onPick,
}: {
  groups: SettingsHitGroup[]
  terms: string[]
  query: string
  active: number
  onActive: (i: number) => void
  onPick: (item: SettingsItem) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // 键盘上下移动时，选中的那项滚进可见范围
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-hit="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  if (!groups.length)
    return (
      <div className="flex flex-col items-center gap-2 px-6 pt-20 text-center">
        <Search className="mb-1 h-5 w-5 text-subtle" strokeWidth={1.6} />
        <p className="text-[0.875rem] font-medium">{t('没有找到「{q}」相关的设置', { q: query.trim() })}</p>
        <p className="text-[0.8125rem] text-subtle">{t('换个说法试试，或者用空格分开几个关键词')}</p>
      </div>
    )
  let n = -1
  return (
    <div ref={listRef} role="listbox" aria-label={t('搜索结果')} className="-mx-3 flex flex-col pt-1">
      {groups.map((g, gi) => (
        <div key={g.section} role="group" aria-label={g.label} className="flex flex-col">
          <div
            className={cn(
              'flex items-center gap-2 px-3 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-subtle',
              gi > 0 ? 'pt-5' : 'pt-1',
            )}
          >
            {g.icon}
            {g.label}
          </div>
          {g.items.map((it) => {
            const i = ++n
            const on = i === active
            const desc = it.desc && snippet(it.desc, terms)
            return (
              <button
                key={`${it.isSection ? '@' : it.isGroup ? '#' : ''}${it.group ?? ''}\u0000${it.title}`}
                type="button"
                role="option"
                aria-selected={on}
                data-hit={i}
                onClick={() => onPick(it)}
                onMouseMove={() => !on && onActive(i)}
                className={cn(
                  'group flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors',
                  on ? 'bg-sel' : 'hover:bg-sel/50',
                )}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[0.875rem] font-medium">
                    <Marked text={it.title} terms={terms} />
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[0.75rem] text-subtle">
                    {it.isSection ? (
                      t('整页')
                    ) : it.isGroup ? (
                      t('小节')
                    ) : it.group ? (
                      <span className="max-w-[14rem] truncate">
                        <Marked text={it.group} terms={terms} />
                      </span>
                    ) : null}
                    <CornerDownLeft className={cn('h-3.5 w-3.5', on ? 'opacity-100' : 'opacity-0')} />
                  </span>
                </span>
                {desc && (
                  <span className="line-clamp-2 text-[0.8125rem] leading-relaxed text-subtle">
                    <Marked text={desc} terms={terms} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** 命中的字标成强调色底 */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-accent-soft text-accent-text">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  )
}
