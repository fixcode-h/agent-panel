import { useState } from 'react'
import { ChevronRight, Clock, Star } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 文件树上面的「收藏」「最近打开」：点一个直接打开。没有时整块不出现；
 * 两块各自能收起（收起状态不记，打开页面时默认展开收藏、收起最近）
 */
export function TableQuick({
  favs,
  recent,
  active,
  onOpen,
  onUnfav,
}: {
  favs: string[]
  recent: string[]
  active?: string
  onOpen: (path: string) => void
  onUnfav: (path: string) => void
}) {
  if (!favs.length && !recent.length) return null
  return (
    <div className="flex flex-col gap-1 border-b pb-1.5 mb-1.5">
      {favs.length > 0 && (
        <Group icon={Star} title={t('收藏')} paths={favs} active={active} onOpen={onOpen} onUnfav={onUnfav} open />
      )}
      {recent.length > 0 && <Group icon={Clock} title={t('最近打开')} paths={recent} active={active} onOpen={onOpen} />}
    </div>
  )
}

function Group({
  icon: Icon,
  title,
  paths,
  active,
  onOpen,
  onUnfav,
  open: init = false,
}: {
  icon: typeof Star
  title: string
  paths: string[]
  active?: string
  onOpen: (path: string) => void
  onUnfav?: (path: string) => void
  open?: boolean
}) {
  const [open, setOpen] = useState(init)
  return (
    <section aria-label={title}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-(--c-row-radius) px-2 text-caption text-subtle hover:bg-hover"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        <Icon className="h-3.5 w-3.5" />
        {title}
        <span className="ml-auto">{paths.length}</span>
      </button>
      {open && (
        <div role="list" className="flex flex-col gap-px">
          {paths.map((p) => (
            <div
              role="listitem"
              key={p}
              className={cn(
                'group flex h-7 items-center rounded-(--c-row-radius) pr-1 pl-7 hover:bg-hover',
                p === active && 'bg-sel font-medium hover:bg-sel',
              )}
            >
              <button
                type="button"
                title={p}
                onClick={() => onOpen(p)}
                className="min-w-0 flex-1 cursor-pointer truncate text-left text-body"
              >
                {p.slice(p.lastIndexOf('/') + 1)}
              </button>
              {onUnfav && (
                <IconButton
                  icon={Star}
                  label={t('取消收藏')}
                  onClick={() => onUnfav(p)}
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
