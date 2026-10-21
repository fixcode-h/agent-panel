import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Search,
  X,
} from 'lucide-react'
import type { ContentFile, FileEntry, FileTree, SearchMode } from '@shared/files'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

/** 按扩展名挑图标，让常见文件一眼能认出来 */
function iconOf(path: string) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return FileImage
  if (/^(json|jsonc|ya?ml|toml|ini|lock)$/.test(ext)) return FileJson
  if (/^(md|mdx|txt|rst)$/.test(ext)) return FileText
  if (/^(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|lua|sh|ps1)$/.test(ext))
    return FileCode2
  return File
}

/** git 状态的颜色和文字 */
const STATUS: Record<string, { label: string; className: string }> = {
  M: { label: 'M', className: 'text-warn' },
  A: { label: 'A', className: 'text-success' },
  '?': { label: 'U', className: 'text-success' },
  D: { label: 'D', className: 'text-danger' },
  R: { label: 'R', className: 'text-accent' },
  U: { label: '!', className: 'text-danger' },
}

interface Node {
  name: string
  path: string
  dir: boolean
  status?: string
  children?: Node[]
}

/** 把文件列表拼成树：目录在前，同级按名字排序 */
function buildTree(files: FileEntry[]): Node[] {
  const root: Node = { name: '', path: '', dir: true, children: [] }
  const dirs = new Map<string, Node>([['', root]])
  const dirOf = (p: string): Node => {
    const hit = dirs.get(p)
    if (hit) return hit
    const cut = p.lastIndexOf('/')
    const parent = dirOf(cut < 0 ? '' : p.slice(0, cut))
    const node: Node = { name: cut < 0 ? p : p.slice(cut + 1), path: p, dir: true, children: [] }
    parent.children!.push(node)
    dirs.set(p, node)
    return node
  }
  for (const f of files) {
    const cut = f.path.lastIndexOf('/')
    const parent = dirOf(cut < 0 ? '' : f.path.slice(0, cut))
    parent.children!.push({
      name: cut < 0 ? f.path : f.path.slice(cut + 1),
      path: f.path,
      dir: false,
      status: f.status,
    })
  }
  const sort = (n: Node) => {
    n.children?.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    n.children?.forEach(sort)
  }
  sort(root)
  return root.children ?? []
}

/** 名称搜索：路径里包含关键词就算命中，文件名命中的排前面 */
function matchByName(files: FileEntry[], q: string) {
  const n = q.trim().toLowerCase()
  if (!n) return files
  const scored: { f: FileEntry; s: number }[] = []
  for (const f of files) {
    const low = f.path.toLowerCase()
    const base = low.slice(low.lastIndexOf('/') + 1)
    const s = base.startsWith(n) ? 0 : base.includes(n) ? 1 : low.includes(n) ? 2 : -1
    if (s >= 0) scored.push({ f, s })
  }
  return scored.sort((a, b) => a.s - b.s || a.f.path.length - b.f.path.length).map((x) => x.f)
}

/**
 * 文件树浏览器：搜索框、名称 / 内容切换、带 git 状态的目录树。
 * 数据由外面传进来，文件和搜索由外面加载，文件页和任务右栏共用这一套。
 */
export function FileExplorer({
  tree,
  error,
  loading,
  hits,
  hitsTruncated,
  searching,
  onSearch,
  onOpen,
  className,
  compact,
}: {
  tree: FileTree | null
  error?: string
  loading?: boolean
  /** 按内容搜索的结果 */
  hits?: ContentFile[]
  hitsTruncated?: boolean
  searching?: boolean
  /** 输入关键词；内容是停顿一下后调用，页面自己发请求 */
  onSearch?: (q: string, mode: SearchMode) => void
  onOpen: (path: string, line?: number) => void
  className?: string
  /** 右栏里的窄版：字号紧一点，搜索结果少列几行 */
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('name')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const input = useRef<HTMLInputElement>(null)

  // 关键词或搜索方式变了通知外面：内容是等停顿后再发请求，名称是本地过滤
  useEffect(() => {
    onSearch?.(query, mode)
    // 只在关键词和方式变化时通知；onSearch 每次渲染都是新函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode])

  const files = useMemo(() => matchByName(tree?.files ?? [], mode === 'name' ? query : ''), [tree, query, mode])
  const treeNodes = useMemo(() => buildTree(files), [files])

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(p)) next.add(p)
      return next
    })

  /** 搜索时把所有目录展开，能看到命中的文件 */
  const expanded = (p: string) => (query.trim() ? true : open.has(p))

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        className={cn(
          'flex shrink-0 flex-col gap-2',
          compact ? 'gap-1.5 px-2 pt-2 pb-2' : 'gap-2.5 border-b px-3 pt-3 pb-3 md:px-5',
        )}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'name' ? t('查找文件') : t('搜索文件内容')}
            className={cn('pl-8.5', compact ? 'h-7 text-[0.75rem]' : 'h-9')}
            aria-label={mode === 'name' ? t('查找文件') : t('搜索文件内容')}
          />
          {query && (
            <button
              aria-label={t('清除搜索')}
              onClick={() => {
                setQuery('')
                input.current?.focus()
              }}
              className="absolute top-1/2 right-2 grid h-5 w-5 -translate-y-1/2 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1" role="tablist" aria-label={t('搜索方式')}>
          {(
            [
              ['name', t('名称')],
              ['content', t('内容')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id)}
              className={cn(
                'cursor-pointer rounded-md text-[0.8125rem] transition-colors',
                compact ? 'h-6 px-2 text-[0.75rem]' : 'h-7 px-2.5',
                mode === id ? 'bg-sel font-medium text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto truncate text-[0.75rem] text-subtle">
            {mode === 'name'
              ? files.length !== tree?.files.length
                ? t('找到 {n} 个', { n: files.length })
                : t('共 {n} 个文件', { n: files.length })
              : searching
                ? t('搜索中…')
                : (hits?.length ?? 0)
                  ? t('{n} 个文件有匹配', { n: hits!.length })
                  : ''}
          </span>
        </div>
      </div>

      <div className={cn('min-h-0 flex-1 overflow-auto py-2', compact ? 'px-1' : 'px-2 md:px-3')}>
        {error ? (
          <p className="p-4 text-[0.8125rem] text-danger">{error}</p>
        ) : loading && !tree ? (
          <div className="flex justify-center p-8 text-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : mode === 'content' ? (
          <ContentResults
            hits={hits ?? []}
            truncated={!!hitsTruncated}
            query={query}
            searching={!!searching}
            onOpen={onOpen}
            compact={compact}
          />
        ) : (
          <>
            {treeNodes.map((n) => (
              <TreeRow
                key={n.path}
                node={n}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                onOpen={onOpen}
                compact={compact}
              />
            ))}
            {!treeNodes.length && (
              <p className="p-4 text-[0.8125rem] text-subtle">
                {query ? t('没有匹配的文件。') : t('这个目录里没有文件。')}
              </p>
            )}
            {tree?.truncated && <p className="px-2 py-3 text-xs text-subtle">{t('文件太多，只列出了前面一部分。')}</p>}
          </>
        )}
      </div>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpen,
  compact,
}: {
  node: Node
  depth: number
  expanded: (p: string) => boolean
  onToggle: (p: string) => void
  onOpen: (path: string) => void
  compact?: boolean
}) {
  const isOpen = node.dir && expanded(node.path)
  const Icon = node.dir ? (isOpen ? FolderOpen : Folder) : iconOf(node.path)
  const status = !node.dir && node.status ? STATUS[node.status] : undefined
  return (
    <>
      <button
        onClick={() => (node.dir ? onToggle(node.path) : onOpen(node.path))}
        // 缩进跟着层级走
        style={{ paddingLeft: `${depth * (compact ? 12 : 14) + 8}px` }}
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 rounded pr-2 text-left text-[0.8125rem] hover:bg-sel',
          compact ? 'h-6' : 'h-7',
          node.dir ? 'text-fg' : 'text-muted hover:text-fg',
        )}
        title={node.path}
      >
        {node.dir ? (
          isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon className={cn('h-3.5 w-3.5 shrink-0', node.dir ? 'text-accent/80' : 'text-subtle')} />
        <span className={cn('min-w-0 truncate font-mono', compact ? 'text-[0.75rem]' : 'text-[0.78125rem]')}>
          {node.name}
        </span>
        {status && (
          <span className={cn('ml-auto shrink-0 font-mono text-[0.6875rem]', status.className)}>{status.label}</span>
        )}
      </button>
      {isOpen &&
        node.children?.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onOpen={onOpen}
            compact={compact}
          />
        ))}
    </>
  )
}

/** 按内容搜索的结果：每个文件一组，下面列出命中的行 */
function ContentResults({
  hits,
  truncated,
  query,
  searching,
  onOpen,
  compact,
}: {
  hits: ContentFile[]
  truncated: boolean
  query: string
  searching: boolean
  onOpen: (path: string, line?: number) => void
  compact?: boolean
}) {
  if (!query.trim()) return <p className="p-4 text-[0.8125rem] text-subtle">{t('输入关键词，搜索文件里的内容。')}</p>
  if (searching && !hits.length)
    return (
      <div className="flex justify-center p-8 text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  if (!hits.length) return <p className="p-4 text-[0.8125rem] text-subtle">{t('没有匹配的内容。')}</p>
  const needle = query.trim().toLowerCase()
  const show = compact ? 3 : 5
  return (
    <div className="flex flex-col gap-1">
      {hits.map((f) => {
        const Icon = iconOf(f.path)
        return (
          <div key={f.path} className="flex flex-col">
            <button
              onClick={() => onOpen(f.path, f.hits[0]?.line)}
              className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-2 text-left hover:bg-sel"
              title={f.path}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className={cn('min-w-0 truncate font-mono', compact ? 'text-[0.75rem]' : 'text-[0.78125rem]')}>
                {f.path}
              </span>
              <span className="ml-auto shrink-0 text-[0.6875rem] text-subtle">{f.hits.length}</span>
            </button>
            {f.hits.slice(0, show).map((h) => (
              <button
                key={h.line}
                onClick={() => onOpen(f.path, h.line)}
                className="ml-5 flex cursor-pointer items-baseline gap-2 rounded py-0.5 pr-2 pl-1 text-left hover:bg-sel"
              >
                <span className="w-8 shrink-0 text-right font-mono text-[0.6875rem] text-subtle/70 tabular-nums">
                  {h.line}
                </span>
                <span className="min-w-0 truncate font-mono text-[0.75rem] text-muted">
                  <Highlight text={h.text} needle={needle} />
                </span>
              </button>
            ))}
            {f.hits.length > show && (
              <button
                onClick={() => onOpen(f.path, f.hits[0]?.line)}
                className="ml-5 cursor-pointer rounded py-0.5 pr-2 pl-1 text-left text-[0.6875rem] text-subtle hover:text-fg"
              >
                {t('还有 {n} 处匹配', { n: f.hits.length - show })}
              </button>
            )}
          </div>
        )
      })}
      {truncated && <p className="px-2 py-3 text-xs text-subtle">{t('匹配太多，只显示了前面一部分。')}</p>}
    </div>
  )
}

/** 把命中的关键词标出来 */
function Highlight({ text, needle }: { text: string; needle: string }) {
  const low = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  for (;;) {
    const at = low.indexOf(needle, i)
    if (at < 0) {
      parts.push(text.slice(i))
      break
    }
    if (at > i) parts.push(text.slice(i, at))
    parts.push(
      <mark key={at} className="rounded-sm bg-warn/25 text-fg">
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    i = at + needle.length
  }
  return <>{parts}</>
}
