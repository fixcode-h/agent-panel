import { Fragment, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, EyeOff } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SheetData } from '@shared/files'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { MenuSearch } from '@/components/ui/menu-search'
import { revealTab, useTabScroll } from '@/components/ui/use-tab-scroll'
import { sheetOrder } from './sheet-look'

/** 工作表多过这么多张时，「全部工作表」里带搜索框 */
const SEARCH_FROM = 10

/**
 * 多张表时的切换条（标题栏下面一行）：放不下时滚轮横着滚，右边出「全部工作表」下拉（和文件页签的「全部页签」一样），
 * 一眼看到全部名字、点一下切过去；切过去的那张自动滚进可见区
 */
export function SheetTabs({
  sheets,
  index,
  onChange,
}: {
  sheets: SheetData[]
  index: number
  onChange: (index: number) => void
}) {
  const scroll = useTabScroll()
  const list = useRef<HTMLDivElement | null>(null)
  // 换了一张（从下拉里选的、搜索跳过去的）：滚到能看见它
  useEffect(() => {
    const tab = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (tab) revealTab(tab)
  }, [index])
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b">
      <div
        ref={(el) => {
          list.current = el
          scroll.ref(el)
        }}
        role="tablist"
        aria-label={t('工作表')}
        // 放不下时两端渐隐（和 TabBar 一样的 tab-scroll），提示左右还有
        data-fade-start={scroll.start || undefined}
        data-fade-end={scroll.end || undefined}
        className="tab-scroll relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sheetOrder(sheets).map((i, k, all) => {
          const s = sheets[i]
          // 隐藏的表排在最后，和前面隔一条竖线
          const first = s.hidden && !sheets[all[k - 1]]?.hidden && k > 0
          return (
            <Fragment key={i}>
              {first && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />}
              <button
                type="button"
                role="tab"
                aria-selected={i === index}
                title={s.hidden ? t('在 Excel 里是隐藏的工作表') : undefined}
                onClick={() => onChange(i)}
                className={cn(
                  'flex h-6 shrink-0 cursor-pointer items-center rounded-md px-2 text-body whitespace-nowrap transition-colors',
                  i === index ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                  s.hidden && i !== index && 'text-subtle',
                )}
              >
                {s.hidden && <EyeOff aria-label={t('隐藏的工作表')} className="mr-1 h-3 w-3 shrink-0" />}
                <span className={cn(s.hidden && 'italic')}>{s.name}</span>
                <span className="ml-1.5 text-caption text-subtle tabular-nums">{s.rows.length}</span>
              </button>
            </Fragment>
          )
        })}
      </div>
      {scroll.overflow && <AllSheets sheets={sheets} index={index} onChange={onChange} />}
    </div>
  )
}

/** 「全部工作表」下拉：名字 + 行数，当前那张打勾；表多时顶上能搜，回车选第一个 */
function AllSheets({
  sheets,
  index,
  onChange,
}: {
  sheets: SheetData[]
  index: number
  onChange: (index: number) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const needle = q.trim().toLowerCase()
  // 和切换条同一个顺序：隐藏的表排在最后
  const shown = sheetOrder(sheets)
    .map((i) => ({ s: sheets[i], i }))
    .filter(({ s }) => !needle || s.name.toLowerCase().includes(needle))
  return (
    <div className="flex shrink-0 items-center border-l px-1">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (o) setQ('')
        }}
      >
        <PopoverTrigger asChild>
          <IconButton icon={ChevronDown} size="xs" label={t('全部工作表（{n} 张）', { n: sheets.length })} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[260px]">
          {sheets.length >= SEARCH_FROM && (
            <MenuSearch
              value={q}
              onChange={setQ}
              placeholder={t('搜索工作表')}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !shown.length) return
                e.preventDefault()
                onChange(shown[0].i)
                setOpen(false)
              }}
            />
          )}
          <div role="list" className="scroll-fade flex max-h-72 flex-col overflow-y-auto">
            {shown.map(({ s, i }) => (
              <PopoverClose key={i} className={menuItem} onClick={() => onChange(i)}>
                {s.hidden && <EyeOff aria-label={t('隐藏的工作表')} className="h-3 w-3 shrink-0 text-subtle" />}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-left',
                    i === index && 'font-medium text-fg',
                    s.hidden && 'text-subtle italic',
                  )}
                >
                  {s.name}
                </span>
                <span className="shrink-0 text-caption text-subtle tabular-nums">{s.rows.length}</span>
                <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                  {i === index && <Check className="h-3.5 w-3.5" strokeWidth={2.2} />}
                </span>
              </PopoverClose>
            ))}
            {!shown.length && <p className="px-2.5 py-2 text-footnote text-subtle">{t('没有叫这个名字的工作表')}</p>}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
