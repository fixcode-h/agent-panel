import type { ReactNode } from 'react'
import { Eye, Package } from 'lucide-react'
import { t } from '@shared/i18n'
import { fileIcon } from '@/lib/file-icon'
import { sizeText } from '@/lib/file-ref'
import { IconButton } from './icon-button'

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/**
 * 「本轮产出」卡片的外框（设计稿 6.7，效果图 8）：标题行（图标、「本轮产出」、一句数量说明、右边一句小字），
 * 网页卡片两列排开，其余文件一行一个（OutputRow），超出的「查看全部」展开。和「完成依据」同一个外形
 */
export function OutputsCard({
  note,
  aside,
  cards,
  children,
  more,
}: {
  /** 标题后面的数量说明 */
  note: string
  /** 标题行最右边的小字（上一轮的去哪找） */
  aside?: string
  /** 网页卡片（HtmlCard），两列排开 */
  cards?: ReactNode
  /** 其余文件（OutputRow） */
  children?: ReactNode
  /** 超过 4 个时的「查看全部 / 收起」 */
  more?: { all: boolean; onToggle: () => void }
}) {
  return (
    <div className="turn-outputs my-1 overflow-hidden rounded-xl border bg-card text-body" data-turn-outputs>
      <div className="flex h-9 items-center gap-2 border-b px-3.5">
        <Package className="h-4 w-4 shrink-0 text-subtle" />
        <span className="shrink-0 font-medium text-fg">{t('本轮产出')}</span>
        <span className="min-w-0 truncate text-xs text-subtle">{note}</span>
        <span className="flex-1" />
        {aside && <span className="hidden min-w-0 truncate text-xs text-subtle sm:inline">{aside}</span>}
      </div>
      {cards && <div className="grid grid-cols-1 gap-2.5 p-2.5 sm:grid-cols-2 [&>*]:max-w-none">{cards}</div>}
      {children && <div className={cards ? 'flex flex-col border-t py-1' : 'flex flex-col py-1'}>{children}</div>}
      {more && (
        <div className="flex h-8 items-center border-t px-3.5">
          <button
            type="button"
            onClick={more.onToggle}
            className="min-w-0 cursor-pointer truncate text-left text-muted hover:text-fg"
          >
            {more.all ? t('收起') : t('查看全部')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 一个不是网页的产出：图标、名字、目录、新建 / 修改、大小，右边预览（图片进灯箱，文档进文件弹窗） */
export function OutputRow({
  path,
  status,
  size,
  onPreview,
}: {
  path: string
  status: 'added' | 'modified'
  size: number
  onPreview: () => void
}) {
  const Icon = fileIcon(path)
  return (
    <div
      title={path}
      data-output-row
      className="group flex h-8 w-full cursor-pointer items-center gap-2 px-3.5 hover:bg-sel/45"
      onClick={onPreview}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
      <span className="shrink-0 truncate text-fg">{baseName(path)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle">{dirName(path)}</span>
      <span className="shrink-0 text-xs text-subtle">
        {status === 'added' ? t('新建') : t('修改')} · {sizeText(size)}
      </span>
      <IconButton
        icon={Eye}
        label={t('预览')}
        onClick={(e) => {
          e.stopPropagation()
          onPreview()
        }}
      />
    </div>
  )
}
