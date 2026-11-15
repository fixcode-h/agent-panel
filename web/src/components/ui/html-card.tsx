import type { ReactNode } from 'react'
import { Code2, ExternalLink, MoreHorizontal, PanelRight } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { sizeText } from '@/lib/file-ref'
import { IconButton } from './icon-button'
import { Menu, MenuContent, MenuTrigger } from './menu'

/**
 * HTML 卡片（设计稿 6.6，效果图 6、7，照 Claude Code 的样子）：回复里的 .html / .htm / .svg 和「本轮产出」里的网页。
 * - large：上面是缩略预览（调用方传进来，通常是 WebFrame 的 thumb），下面一行写标题、类型 · 大小 · 文件名，右边「打开」「新窗口」「更多」
 * - small：只有一行，同一条回复里第二个起、或同一个文件后面再提到时用，免得回复被几张大图撑长
 * 整张都能点（在右栏打开）；正在右栏显示的描一圈强调色、角上写「右栏正在显示」，这时不再显示「打开」。
 * 圆角、要不要预览、预览高度、描边颜色在设置 →「组件」里调（--c-htmlCard-*）
 */
export function HtmlCard({
  title,
  name,
  size,
  kind = 'HTML',
  variant = 'large',
  preview,
  active,
  onOpen,
  onNewWindow,
  menu,
  className,
}: {
  /** 网页的 <title>，取不到时调用方传文件名 */
  title: string
  /** 文件名或相对路径：标题下面那行最后一段 */
  name: string
  /** 字节数；还没取到时不写 */
  size?: number
  /** 类型字样：HTML / SVG */
  kind?: string
  variant?: 'large' | 'small'
  /** 缩略预览；没有（超过大小、打不开、同时预览太多）时显示图标占位 */
  preview?: ReactNode
  active?: boolean
  onOpen: () => void
  onNewWindow?: () => void
  /** 「更多」菜单的内容（MenuItem）：复制路径、在文件浏览里显示、发给对话 */
  menu?: ReactNode
  className?: string
}) {
  const large = variant === 'large'
  const meta = [kind, size !== undefined ? sizeText(size) : '', name].filter(Boolean).join(' · ')
  // 卡片里的按钮自己处理点击，不冒泡成「点卡片」
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div
      role="button"
      tabIndex={0}
      data-html-card={variant}
      data-active={active ? '' : undefined}
      title={name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'group/html relative flex w-full max-w-[560px] min-w-0 cursor-pointer flex-col overflow-hidden rounded-(--c-htmlCard-radius) border bg-card text-left text-body outline-none transition-colors hover:bg-sel/35 focus-visible:ring-[3px] focus-visible:ring-focus-soft',
        active && 'border-(--c-htmlCard-active) ring-1 ring-(--c-htmlCard-active)',
        className,
      )}
    >
      {large && (
        <div className="relative h-(--c-htmlCard-previewH) overflow-hidden border-b bg-panel [display:var(--c-htmlCard-preview)]">
          {preview ?? (
            <div className="grid h-full place-items-center text-subtle">
              <Code2 className="h-8 w-8" strokeWidth={1.5} />
            </div>
          )}
          {/* 预览不响应鼠标：上面盖一层，点哪里都是点卡片 */}
          <div className="absolute inset-0" aria-hidden />
        </div>
      )}
      {active && (
        <span className="absolute top-2 right-2 rounded-md border border-(--c-htmlCard-active) bg-card px-1.5 py-0.5 text-xs font-medium text-(--c-htmlCard-active)">
          {t('右栏正在显示')}
        </span>
      )}
      <div className={cn('flex min-w-0 items-center gap-3 px-3', large ? 'py-2.5' : 'py-2')}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <Code2 className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-fg">{title}</span>
          <span className="truncate font-mono text-xs text-subtle">{meta}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1" onClick={stop} onKeyDown={stop}>
          {!active && (
            <button
              type="button"
              onClick={onOpen}
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-hover px-2.5 text-xs text-fg transition-colors hover:bg-active"
            >
              <PanelRight className="h-3.5 w-3.5" />
              {t('打开')}
            </button>
          )}
          {onNewWindow && <IconButton icon={ExternalLink} size="sm" label={t('在新窗口打开')} onClick={onNewWindow} />}
          {menu && (
            <Menu>
              <MenuTrigger asChild>
                <IconButton icon={MoreHorizontal} size="sm" label={t('更多')} />
              </MenuTrigger>
              <MenuContent align="end">{menu}</MenuContent>
            </Menu>
          )}
        </span>
      </div>
    </div>
  )
}
