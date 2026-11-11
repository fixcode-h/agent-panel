import { FileSpreadsheet, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/**
 * 表格页顶上打开的文件页签：像编辑器一样能同时开几个表来回切。
 * 有没保存改动的页签名字后面一个点，悬停时点换成关闭按钮
 */
export function TableTabs({
  paths,
  active,
  dirty,
  onPick,
  onClose,
  children,
}: {
  paths: string[]
  active: string
  dirty?: Set<string>
  onPick: (p: string) => void
  onClose: (p: string) => void
  /** 页签右边的操作（保存、对比……） */
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-10 shrink-0 items-stretch border-b bg-panel">
      <div role="tablist" aria-label={t('打开的表格')} className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {paths.map((p) => {
          const on = p === active
          const changed = !!dirty?.has(p)
          return (
            <div
              key={p}
              className={cn(
                'group/tab relative flex shrink-0 items-center border-r',
                on ? 'bg-bg text-fg' : 'text-muted hover:bg-hover hover:text-fg',
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
                className="flex h-full max-w-[220px] cursor-pointer items-center gap-1.5 pr-1 pl-3 text-body"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="truncate">{p.slice(p.lastIndexOf('/') + 1)}</span>
              </button>
              <button
                type="button"
                aria-label={t('关闭 {name}', { name: p.slice(p.lastIndexOf('/') + 1) })}
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
          )
        })}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1 px-2">{children}</div>}
    </div>
  )
}
