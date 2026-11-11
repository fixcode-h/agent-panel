import { useState } from 'react'
import { ChevronDown, FileSpreadsheet, Lock, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@/components/ui/menu'
import { IconButton } from '@/components/ui/icon-button'
import { middleEllipsis } from './table-tree'

/** 页签多过这么多个时，右边出「全部页签」下拉 */
const MANY = 5

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/**
 * 表格页顶上打开的文件页签：像编辑器一样能同时开几个表来回切。
 * 有没保存改动的页签名字后面一个点，悬停时点换成关闭按钮；只读的带锁。
 * 中键关闭，右键「关闭其它 / 关闭右侧 / 复制路径 / 在文件树中定位」，拖动排序；多了右边有「全部页签」下拉
 */
export function TableTabs({
  paths,
  active,
  dirty,
  readOnly,
  onPick,
  onClose,
  onCloseMany,
  onReorder,
  onLocate,
  children,
}: {
  paths: string[]
  active: string
  dirty?: Set<string>
  readOnly?: Set<string>
  onPick: (p: string) => void
  onClose: (p: string) => void
  /** 一次关几个（有没保存改动的留着，由外面决定） */
  onCloseMany?: (ps: string[]) => void
  onReorder?: (paths: string[]) => void
  /** 在左边文件树里定位 */
  onLocate?: (p: string) => void
  /** 页签右边的操作（保存、对比……） */
  children?: React.ReactNode
}) {
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const drop = (target: string) => {
    if (!drag || drag === target || !onReorder) return
    const rest = paths.filter((p) => p !== drag)
    rest.splice(rest.indexOf(target) + (paths.indexOf(drag) < paths.indexOf(target) ? 1 : 0), 0, drag)
    onReorder(rest)
  }
  return (
    <div className="flex h-10 shrink-0 items-stretch border-b bg-panel">
      <div role="tablist" aria-label={t('打开的表格')} className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {paths.map((p, i) => {
          const on = p === active
          const changed = !!dirty?.has(p)
          const locked = !!readOnly?.has(p)
          const name = baseName(p)
          return (
            <ContextMenu key={p}>
              <ContextMenuTrigger asChild>
                <div
                  draggable={!!onReorder}
                  onDragStart={(e) => {
                    setDrag(p)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (!drag) return
                    e.preventDefault()
                    setOver(p)
                  }}
                  onDragLeave={() => setOver((o) => (o === p ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault()
                    drop(p)
                    setDrag(null)
                    setOver(null)
                  }}
                  onDragEnd={() => {
                    setDrag(null)
                    setOver(null)
                  }}
                  className={cn(
                    'group/tab relative flex shrink-0 items-center border-r',
                    on ? 'bg-bg text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                    drag === p && 'opacity-50',
                    over === p && drag !== p && 'shadow-[inset_2px_0_0_var(--accent)]',
                  )}
                >
                  {on && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    title={p}
                    onClick={() => onPick(p)}
                    onAuxClick={(e) => e.button === 1 && onClose(p)}
                    className="flex h-full max-w-[240px] cursor-pointer items-center gap-1.5 pr-1 pl-3 text-body"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    <span className="truncate">{middleEllipsis(name)}</span>
                    {locked && <Lock aria-label={t('只读')} className="h-3 w-3 shrink-0 text-subtle" />}
                  </button>
                  <button
                    type="button"
                    aria-label={t('关闭 {name}', { name })}
                    title={changed ? t('有未保存的改动') : t('关闭')}
                    onClick={() => onClose(p)}
                    className="mr-1.5 grid h-5 w-5 cursor-pointer place-items-center rounded-sm text-subtle hover:bg-active hover:text-fg"
                  >
                    {changed ? (
                      <>
                        <span className="h-2 w-2 rounded-full bg-accent group-hover/tab:hidden" />
                        <X className="hidden h-3 w-3 group-hover/tab:block" />
                      </>
                    ) : (
                      <X className={cn('h-3 w-3', !on && 'opacity-0 group-hover/tab:opacity-100')} />
                    )}
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onClose(p)}>{t('关闭')}</ContextMenuItem>
                {onCloseMany && paths.length > 1 && (
                  <ContextMenuItem onSelect={() => onCloseMany(paths.filter((x) => x !== p))}>
                    {t('关闭其它')}
                  </ContextMenuItem>
                )}
                {onCloseMany && i < paths.length - 1 && (
                  <ContextMenuItem onSelect={() => onCloseMany(paths.slice(i + 1))}>{t('关闭右侧')}</ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void copyText(p, { done: t('已复制路径') })}>
                  {t('复制路径')}
                </ContextMenuItem>
                {onLocate && <ContextMenuItem onSelect={() => onLocate(p)}>{t('在文件树中定位')}</ContextMenuItem>}
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      {paths.length > MANY && (
        <div className="flex shrink-0 items-center border-l px-1">
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={ChevronDown} label={t('全部页签（{n} 个）', { n: paths.length })} />
            </MenuTrigger>
            <MenuContent align="end">
              {paths.map((p) => (
                <MenuItem key={p} onSelect={() => onPick(p)} className={cn(p === active && 'font-semibold')}>
                  <span className="min-w-0 flex-1 truncate">{baseName(p)}</span>
                  {dirty?.has(p) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
      )}
      {children && <div className="flex shrink-0 items-center gap-1 px-2">{children}</div>}
    </div>
  )
}
