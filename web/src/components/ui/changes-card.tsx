import type { ReactNode } from 'react'
import { FileDiff, Undo2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { fileIcon } from '@/lib/file-icon'
import { cn } from '@/lib/utils'
import { Segmented } from './segmented'

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

export interface ChangesCardFile {
  path: string
  add: number
  del: number
  /** 这一段里新建的文件：文件名后面标「新建」 */
  added?: boolean
}

export type ChangesScope = 'round' | 'conv'

/**
 * 改动卡片的外形（设计稿 designs/Bug模式子对话体验-设计稿.md 第 3 节，效果图 5）：对话停下后最后面那张。
 * 标题左边「这一轮 N / 整个对话 M」分段（两段一样时不画），标题、增删行数、查看改动、撤销（跟着分段切换），
 * 文件一行一个，超出的「查看全部」展开，底部一行说明（这一轮从哪算起、别的对话改的没算进来）。
 * 数据和接口在 web/src/components/tasks/TurnChanges.tsx 的 ConvChangesCard；设置 → 组件 →「改动卡片」调圆角、默认看哪一段、先列几个。
 *
 * tag：按路径给文件行加标签（Bug 模式里补排查动过的文件标「排查」），不给就不加
 */
export function ChangesCard({
  title,
  scope,
  files,
  first,
  all,
  onAll,
  reverted,
  onOpen,
  revert,
  tag,
  footer,
  children,
}: {
  title: string
  scope?: { value: ChangesScope; onChange: (v: ChangesScope) => void; round: number; conv: number }
  files: ChangesCardFile[]
  /** 先列几个文件 */
  first: number
  all: boolean
  onAll: () => void
  /** 撤销过：卡片变灰，只留标题 */
  reverted: boolean
  onOpen: (path: string) => void
  revert?: { label: string; title: string; disabled?: boolean; onClick: () => void }
  tag?: (path: string) => ReactNode
  /** 底部的说明行（一行一条） */
  footer?: ReactNode
  /** 卡片最下面的附加内容（撤不干净时的冲突列表） */
  children?: ReactNode
}) {
  const shown = all ? files : files.slice(0, first)
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)
  return (
    <div
      // 按卡片自己的宽度收窄：右栏开着时对话栏只有四百多宽，按钮只留图标，标题和切换不被挤没
      className="turn-changes @container my-1 overflow-hidden rounded-(--c-changesCard-radius) border bg-card text-body"
      data-changes-card
    >
      <div className="flex h-9 items-center gap-2 border-b px-3.5">
        {scope && (
          <Segmented
            size="sm"
            className="shrink-0 flex-nowrap"
            label={t('改动的范围')}
            value={scope.value}
            onChange={scope.onChange}
            options={[
              { id: 'round', label: t('这一轮 {n}', { n: scope.round }) },
              { id: 'conv', label: t('整个对话 {n}', { n: scope.conv }) },
            ]}
          />
        )}
        <span className={cn('min-w-0 truncate font-medium', reverted ? 'text-subtle' : 'text-fg')}>{title}</span>
        {!reverted && files.length > 0 && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
            <span className="text-success">+{add.toLocaleString()}</span>
            <span className="text-danger">-{del.toLocaleString()}</span>
          </span>
        )}
        <span className="flex-1" />
        {!reverted && files.length > 0 && (
          <button
            type="button"
            onClick={() => onOpen(files[0].path)}
            aria-label={t('查看改动')}
            title={t('查看改动')}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-sel hover:text-fg"
          >
            <FileDiff className="h-3.5 w-3.5" />
            <span className="hidden @[36rem]:inline">{t('查看改动')}</span>
          </button>
        )}
        {!reverted && files.length > 0 && revert && (
          <button
            type="button"
            onClick={revert.onClick}
            disabled={revert.disabled}
            title={revert.title}
            aria-label={revert.label}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Undo2 className="h-3.5 w-3.5" />
            <span className="hidden @[36rem]:inline">{revert.label}</span>
          </button>
        )}
      </div>
      {!reverted && shown.length > 0 && (
        <div className="flex flex-col py-1">
          {shown.map((f) => {
            const Icon = fileIcon(f.path)
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => onOpen(f.path)}
                title={f.path}
                className="flex h-7 w-full cursor-pointer items-center gap-2 px-3.5 text-left hover:bg-sel"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="shrink-0 truncate">{baseName(f.path)}</span>
                {f.added && (
                  <span className="shrink-0 rounded-(--c-badge-radius) bg-success/12 px-1.5 text-xs text-success">
                    {t('新建')}
                  </span>
                )}
                {tag?.(f.path)}
                {/* 目录跟在文件名后面、灰一点：同名文件（index.ts）分得开，又不抢文件名 */}
                <span className="min-w-0 flex-1 truncate text-xs text-subtle">{dirName(f.path)}</span>
                <span className="shrink-0 font-mono text-xs text-success">+{f.add}</span>
                <span className="w-9 shrink-0 text-right font-mono text-xs text-danger">
                  {f.del ? `-${f.del}` : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {!reverted && files.length > first && (
        <div className="flex h-8 items-center border-t px-3.5">
          <button
            type="button"
            onClick={onAll}
            className="min-w-0 cursor-pointer truncate text-left text-muted hover:text-fg"
          >
            {all ? t('收起') : t('查看全部 {n} 个文件', { n: files.length })}
          </button>
        </div>
      )}
      {footer}
      {children}
    </div>
  )
}

/** 卡片底部的一行小字说明 */
export function ChangesCardNote({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="turn-changes-others border-t px-3.5 py-1.5 text-xs text-subtle" title={title}>
      {children}
    </div>
  )
}
