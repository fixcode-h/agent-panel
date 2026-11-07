import { useEffect, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { IconButton } from '@/components/ui/icon-button'
import { MenuSearch } from '@/components/ui/menu-search'
import { HIT_MAX } from '@/lib/file-search'
import { cn } from '@/lib/utils'

/**
 * 文件弹窗自己的搜索：阅读代码时行是虚拟渲染的，浏览器自带的查找（Ctrl+F）搜不到屏幕外的行，
 * 所以弹窗里按 Ctrl+F 打开这一条搜索框，阅读代码、Markdown、编辑三种模式共用。
 * 命中多少、当前第几处由各模式自己算好传进来；这里只管输入、切换和快捷键。
 */
export function useFileSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [index, setIndex] = useState(0)
  /** 每按一次上一个 / 下一个加一：停在同一处（只有一处命中）时也要重新滚过去 */
  const [seq, setSeq] = useState(0)
  const [focusTick, setFocusTick] = useState(0)
  const step = (total: number, by: 1 | -1) => {
    if (!total) return
    setIndex((i) => (((i + by) % total) + total) % total)
    setSeq((s) => s + 1)
  }
  return {
    open,
    query,
    caseSensitive,
    index,
    seq,
    focusTick,
    /** 打开（已经开着就重新聚焦并全选）；selected 是当前选中的字，带进搜索框 */
    show: (selected?: string) => {
      setOpen(true)
      if (selected && !selected.includes('\n')) {
        setQuery(selected)
        setIndex(0)
      }
      setFocusTick((n) => n + 1)
    },
    close: () => setOpen(false),
    setQuery: (q: string) => {
      setQuery(q)
      setIndex(0)
      setSeq((s) => s + 1)
    },
    toggleCase: () => {
      setCaseSensitive((v) => !v)
      setIndex(0)
      setSeq((s) => s + 1)
    },
    next: (total: number) => step(total, 1),
    prev: (total: number) => step(total, -1),
    /** 命中数变少了（内容改了）时把当前位置收回范围内 */
    clamp: (total: number) => {
      if (index >= total && total) setIndex(total - 1)
    },
  }
}

export type FileSearch = ReturnType<typeof useFileSearch>

/** 标题栏下面的一条搜索框：输入、命中数、区分大小写、上一个 / 下一个、关闭 */
export function FileSearchBar({ search, total, onClose }: { search: FileSearch; total: number; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!search.open) return
    input.current?.focus()
    input.current?.select()
  }, [search.open, search.focusTick])
  useEffect(() => search.clamp(total))
  if (!search.open) return null
  const count = !search.query
    ? ''
    : total
      ? `${search.index + 1} / ${total >= HIT_MAX ? `${HIT_MAX}+` : total}`
      : t('无结果')
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-3" role="search">
      <MenuSearch
        ref={input}
        value={search.query}
        onChange={search.setQuery}
        placeholder={t('在文件中查找')}
        className="mb-0 h-7 max-w-[360px] flex-1"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'F3') {
            e.preventDefault()
            if (e.shiftKey) search.prev(total)
            else search.next(total)
          }
          // Esc 由弹窗统一处理（FileViewDialog 的 onEscapeKeyDown）：搜索框开着时先关它，不把弹窗也关掉
        }}
      />
      <span
        aria-live="polite"
        className={cn(
          'min-w-14 shrink-0 px-1 text-caption tabular-nums',
          search.query && !total ? 'text-warning' : 'text-subtle',
        )}
      >
        {count}
      </span>
      <IconButton
        icon={CaseSensitive}
        label={t('区分大小写')}
        aria-pressed={search.caseSensitive}
        className={cn(search.caseSensitive && 'bg-active text-fg')}
        onClick={search.toggleCase}
      />
      <IconButton icon={ChevronUp} label={t('上一个')} disabled={!total} onClick={() => search.prev(total)} />
      <IconButton icon={ChevronDown} label={t('下一个')} disabled={!total} onClick={() => search.next(total)} />
      <IconButton icon={X} label={t('关闭搜索')} onClick={onClose} />
    </div>
  )
}
