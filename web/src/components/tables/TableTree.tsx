import { useMemo, useState } from 'react'
import { ChevronRight, FileSpreadsheet, FileText, Folder } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableFile } from '@shared/tables'
import { cn } from '@/lib/utils'
import { buildTableTree, type TableNode } from './table-tree'

/** 每层缩进 */
const INDENT = 14

/**
 * 表格页左侧的文件树：按目录分层，名字搜索时只留命中的文件（和它们的上级目录，全部展开）。
 * 行的样子和任务右栏的文件树一致（28px 行、正文字体、选中浅底加粗），行高、圆角跟着设置里的「列表行」走
 */
export function TableTree({
  files,
  query,
  active,
  dirty,
  onOpen,
}: {
  files: TableFile[]
  /** 名字搜索 */
  query: string
  active?: string
  /** 有没保存改动的文件：名字后面一个点 */
  dirty?: Set<string>
  onOpen: (path: string) => void
}) {
  const tree = useMemo(() => buildTableTree(files, query), [files, query])
  // 默认展开第一层；搜索时全部展开
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const toggle = (p: string) =>
    setFolded((s) => {
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
      const open = !!query || !folded.has(n.path)
      rows.push(
        <TreeRow
          key={n.path}
          node={n}
          depth={depth}
          open={open}
          active={n.path === active}
          dirty={!!dirty?.has(n.path)}
          onClick={() => (n.file ? onOpen(n.path) : toggle(n.path))}
        />,
      )
      if (!n.file && open) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)
  return (
    <div role="tree" aria-label={t('表格文件')} className="flex flex-col gap-px">
      {rows}
    </div>
  )
}

function TreeRow({
  node,
  depth,
  open,
  active,
  dirty,
  onClick,
}: {
  node: TableNode
  depth: number
  open: boolean
  active: boolean
  dirty: boolean
  onClick: () => void
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
