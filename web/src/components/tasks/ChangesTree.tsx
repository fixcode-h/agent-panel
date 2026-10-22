import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import type { FileChange } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { fileIcon } from '@/lib/file-icon'
import { buildChangeTree, visibleChangeRows } from './changes-tree'

/** 一次渲染这么多行，再多的点「显示更多」；上千个文件也不会一次建几千个 DOM */
const PAGE = 400

/**
 * 「改动」的树形视图：按目录分组，目录行汇总下面所有文件的增删行数，点文件看差异。
 * 展开状态由外面保存，切换到列表再切回来不丢。
 */
export function ChangesTree({
  changes,
  onDiff,
  scoped,
  collapsed,
  onToggle,
}: {
  changes: FileChange[]
  onDiff: (path: string) => void
  /** 看的是流程图里选中的节点，不是整个任务 */
  scoped: boolean
  /** 收起的目录；默认全展开，所以空集合就是全展开 */
  collapsed: Set<string>
  onToggle: (path: string) => void
}) {
  const [shown, setShown] = useState(PAGE)
  const tree = useMemo(() => buildChangeTree(changes), [changes])
  const rows = useMemo(() => visibleChangeRows(tree, collapsed), [tree, collapsed])

  if (!changes.length)
    return (
      <p className="p-4 text-[0.8125rem] text-subtle">{scoped ? t('这个节点没有改动文件。') : t('还没有改动文件。')}</p>
    )

  return (
    <div className="flex flex-col">
      {rows.slice(0, shown).map(({ node, depth }) => {
        const open = node.dir && !collapsed.has(node.path)
        const Icon = node.dir ? (open ? FolderOpen : Folder) : fileIcon(node.path)
        return (
          <button
            key={`${node.dir ? 'd' : 'f'}:${node.path}`}
            type="button"
            onClick={() => (node.dir ? onToggle(node.path) : onDiff(node.path))}
            // 缩进跟着层级走；再深的路径也不会把名字挤没，名字自己截断
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            title={node.dir ? node.path : t('查看「{path}」的改动', { path: node.path })}
            aria-expanded={node.dir ? open : undefined}
            className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-lg pr-2 text-left font-mono text-xs outline-none hover:bg-sel"
          >
            {node.dir ? (
              open ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
              )
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <Icon className={cn('h-3.5 w-3.5 shrink-0', node.dir ? 'text-accent/80' : 'text-subtle')} />
            <span className={cn('min-w-0 flex-1 truncate', node.dir ? 'text-fg' : 'text-muted')}>{node.name}</span>
            <span className="shrink-0 text-success">+{node.add}</span>
            <span className="w-8 shrink-0 text-right text-danger">{node.del ? `-${node.del}` : ''}</span>
          </button>
        )
      })}
      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="flex h-7 cursor-pointer items-center rounded px-2 text-left text-[0.75rem] text-accent hover:bg-sel"
        >
          {t('显示更多（还有 {n} 项）', { n: rows.length - shown })}
        </button>
      )}
    </div>
  )
}
