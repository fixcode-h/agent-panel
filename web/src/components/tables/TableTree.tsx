import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileSpreadsheet, FileText, Folder } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableFile } from '@shared/tables'
import { exportName, type TableExport } from '@shared/table-export'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/copy-text'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { buildTableTree, type TableNode } from './table-tree'

/** 每层缩进 */
const INDENT = 14

/**
 * 表格页左侧的文件树：按目录分层，文件夹默认折叠，展开了才画里面的行（几千张表也不卡）；
 * 只有一个顶层目录时它默认展开，打开的文件所在的目录自动展开。名字搜索时只留命中的文件（和它们的上级目录，全部展开）。
 * 行的样子和任务右栏的文件树一致（28px 行、正文字体、选中浅底加粗），行高、圆角跟着设置里的「列表行」走
 */
export function TableTree({
  files,
  query,
  active,
  dirty,
  onOpen,
  exports = [],
  onExport,
  isFav,
  onFav,
  onReveal,
}: {
  /** 收藏：右键文件「收藏 / 取消收藏」 */
  isFav?: (path: string) => boolean
  onFav?: (path: string) => void
  /** 在系统的文件管理器里显示 */
  onReveal?: (path: string) => void
  files: TableFile[]
  /** 项目设置里的导表脚本：右键文件 / 文件夹可以对它们执行 */
  exports?: TableExport[]
  onExport?: (index: number, paths: string[]) => void
  /** 名字搜索 */
  query: string
  active?: string
  /** 有没保存改动的文件：名字后面一个点 */
  dirty?: Set<string>
  onOpen: (path: string) => void
}) {
  const tree = useMemo(() => buildTableTree(files, query), [files, query])
  // 右键的是哪一行：整棵树只挂一个右键菜单（几千行每行一个菜单太重）
  const [menuAt, setMenuAt] = useState<TableNode | null>(null)
  // 展开了的文件夹：默认全折叠；只有一个顶层目录时展开它
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const single = tree.length === 1 && !tree[0].file ? tree[0].path : ''
  useEffect(() => {
    if (single) setOpened((s) => (s.has(single) ? s : new Set(s).add(single)))
  }, [single])
  // 打开的文件所在的各级目录跟着展开（从内容搜索、检查结果跳过来时能看到它在哪）
  useEffect(() => {
    if (!active) return
    const parts = active.split('/')
    setOpened((s) => {
      const next = new Set(s)
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
      return next.size === s.size ? s : next
    })
  }, [active])
  const toggle = (p: string) =>
    setOpened((s) => {
      const next = new Set(s)
      if (!next.delete(p)) next.add(p)
      return next
    })
  if (!tree.length)
    return (
      <p className="px-3 py-6 text-center text-footnote text-subtle">
        {query ? t('没有名字里带「{q}」的表格', { q: query }) : t('表格目录里还没有表格')}
      </p>
    )
  const rows: React.ReactNode[] = []
  const walk = (nodes: TableNode[], depth: number) => {
    for (const n of nodes) {
      const open = !!query || opened.has(n.path)
      rows.push(
        <TreeRow
          key={n.path}
          node={n}
          depth={depth}
          open={open}
          active={n.path === active}
          dirty={!!dirty?.has(n.path)}
          onClick={() => (n.file ? onOpen(n.path) : toggle(n.path))}
          onMenu={() => setMenuAt(n)}
        />,
      )
      if (!n.file && open) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)
  const under = menuAt ? filesUnder(menuAt) : []
  return (
    <ContextMenu onOpenChange={(o) => !o && setMenuAt(null)}>
      <ContextMenuTrigger asChild>
        <div role="tree" aria-label={t('表格文件')} className="flex flex-col gap-px">
          {rows}
        </div>
      </ContextMenuTrigger>
      {menuAt && (
        <ContextMenuContent>
          {menuAt.file && <ContextMenuItem onSelect={() => onOpen(menuAt.path)}>{t('打开')}</ContextMenuItem>}
          {menuAt.file && onFav && (
            <ContextMenuItem onSelect={() => onFav(menuAt.path)}>
              {isFav?.(menuAt.path) ? t('取消收藏') : t('收藏')}
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void copyText(menuAt.path, { done: t('已复制路径') })}>
            {t('复制路径')}
          </ContextMenuItem>
          {onReveal && (
            <ContextMenuItem onSelect={() => onReveal(menuAt.path)}>{t('在文件管理器中显示')}</ContextMenuItem>
          )}
          {onExport && exports.length > 0 && under.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuLabel>
                {menuAt.file ? t('导表') : t('导表（这个文件夹里 {n} 张表）', { n: under.length })}
              </ContextMenuLabel>
              {exports.map((x, i) => (
                <ContextMenuItem key={i} onSelect={() => onExport(i, under)}>
                  {exportName(x, i)}
                </ContextMenuItem>
              ))}
            </>
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

/** 一个节点下的所有表格（老 .xls 不能导也照样传，脚本自己决定） */
function filesUnder(n: TableNode): string[] {
  if (n.file) return [n.path]
  return n.children.flatMap(filesUnder)
}

function TreeRow({
  node,
  depth,
  open,
  active,
  dirty,
  onClick,
  onMenu,
}: {
  node: TableNode
  depth: number
  open: boolean
  active: boolean
  dirty: boolean
  onClick: () => void
  onMenu: () => void
}) {
  const f = node.file
  const Icon = !f ? Folder : f.kind === 'csv' ? FileText : FileSpreadsheet
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={f ? undefined : open}
      aria-selected={active}
      title={node.path}
      onClick={onClick}
      onContextMenu={onMenu}
      style={{ paddingLeft: `${6 + depth * INDENT}px` }}
      className={cn(
        'flex h-7 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-(--c-row-radius) pr-2 text-left text-body transition-colors hover:bg-sel/60',
        f ? 'text-fg aria-selected:bg-sel aria-selected:font-semibold' : 'font-medium text-muted',
      )}
    >
      <ChevronRight
        aria-hidden
        className={cn('h-3 w-3 shrink-0 text-subtle transition-transform', f && 'invisible', open && 'rotate-90')}
      />
      <Icon className={cn('h-3.5 w-3.5 shrink-0', f ? 'text-muted' : 'text-subtle')} />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('有未保存的改动')} />}
      {f?.kind === 'xls' && <span className="shrink-0 text-caption text-subtle">{t('只读')}</span>}
      {!f && <span className="shrink-0 text-caption text-subtle tabular-nums">{node.count}</span>}
    </button>
  )
}
