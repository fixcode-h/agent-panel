import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 来源链接一行（组件库「SourceLink」，Chat.dc.html 右栏「来源」页签）：
 * 左边一个方块写域名首字母，域名是正文、路径是小字，整行可点，新标签页打开。
 * 方块不取网站图标：在线拿 favicon 要访问外网，本机面板不该替用户去连别人的服务器
 */
export function SourceLink({
  url,
  host,
  path,
  note,
  className,
}: {
  url: string
  host: string
  /** 域名后面的路径（可空） */
  path?: string
  /** 行尾的小字：哪次搜索带出来的 */
  note?: string
  className?: string
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      className={cn(
        'group/src flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[0.8125rem] transition-colors hover:bg-sel/60',
        className,
      )}
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-sel text-[0.6875rem] font-semibold text-muted uppercase">
        {host.slice(0, 1)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-fg">{host}</span>
        {(path || note) && (
          <span className="truncate text-[0.6875rem] text-subtle">{[path, note].filter(Boolean).join(' · ')}</span>
        )}
      </span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition-opacity group-hover/src:opacity-100" />
    </a>
  )
}
