import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ContentFile, DirLevel, FileTree, NameSearch, SearchMode } from '@shared/files'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { startFileDrag } from '@/lib/fileDrag'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'

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

/** 一层里一次渲染这么多行，再多的点「显示更多」；几万个项的目录也不会一次建几万个 DOM */
const PAGE = 400

/**
 * 复制文字：优先用剪贴板接口；它要求安全上下文（http 的局域网地址、被嵌在 iframe 里时会不可用），
 * 失败时退回选中一个临时 textarea 再 execCommand，最后才提示复制失败。
 */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('已复制'))
    return
  } catch {}
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(area)
  if (ok) toast.success(t('已复制'))
  else toast.error(t('复制失败'))
}

/** 目录一层现在处于什么状态 */
export interface LevelState {
  /** 正在请求这一层：首次读取时显示「读取中…」；已有旧数据时只在后台重读，界面照常显示旧内容 */
  loading: boolean
  error: string
}

/**
 * 文件浏览的数据来源：根信息按层读取，目录展开时才请求那一层，已经读过的层缓存下来。
 * 项目文件页、项目工作区和任务右栏共用这一套。
 */
export interface FileBrowser {
  /** 根信息：目录、分支、是不是 git 仓库 */
  info: FileTree | null
  error: string
  loading: boolean
  /** 已经读到的层，键是相对目录（根目录是空字符串） */
  levels: Record<string, DirLevel>
  levelState: (path: string) => LevelState
  /** 读一层；已经读过或正在读时不重复请求 */
  load: (path: string) => void
  /** 重新读根信息和已经展开的层 */
  refresh: () => void
  /** 刷新时加一：已经展开的层据此重新请求 */
  version: number
  /** 按文件名搜索的结果；服务端搜，还没展开的深层文件也能找到 */
  names: NameSearch | null
  namesLoading: boolean
  namesError: string
  /** 按内容搜索的结果 */
  hits: ContentFile[]
  hitsTruncated: boolean
  searching: boolean
  /** 输入关键词；内容是停顿一下后调用，页面自己发请求 */
  search: (q: string, mode: SearchMode) => void
  /** 在系统的文件管理器里打开文件或目录；不传路径时打开项目（任务）目录 */
  reveal: (path?: string) => void
  /** 相对路径对应的绝对路径，「复制绝对路径」用；拿不到时返回空串 */
  absolute: (path: string) => string
}

/**
 * 文件浏览器：搜索框、名称 / 内容切换、按层加载的目录树。
 * 数据由外面传进来（项目和任务各有一套接口），文件页和任务右栏共用这一套。
 */
export function FileExplorer({
  browser,
  onOpen,
  className,
  compact,
}: {
  browser: FileBrowser
  onOpen: (path: string, line?: number) => void
  className?: string
  /** 右栏里的窄版：字号紧一点，搜索结果少列几行 */
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('name')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const input = useRef<HTMLInputElement>(null)

  const needle = query.trim()
  // 关键词或搜索方式变了通知外面：名称和内容都由服务端搜，内容再停顿一下
  useEffect(() => {
    browser.search(query, mode)
    // 只在关键词和方式变化时通知；search 每次渲染都是新函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode])

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(p)) next.add(p)
      return next
    })

  /**
   * 全部展开：只展开已经读过的层，再往下每层都按需请求一层，不做全量扫描。
   * 代价是要逐层发请求（每层一次），极深的大项目会点很多次；点「显示更多」的行不受影响。
   * 全部收起只清展开状态，缓存留着。
   */
  const expandAll = () => {
    const dirs = new Set<string>()
    for (const level of Object.values(browser.levels))
      for (const e of level.entries) if (e.kind === 'dir') dirs.add(e.path)
    setOpen(dirs)
    for (const p of dirs) browser.load(p)
  }
  const collapseAll = () => setOpen(new Set())

  const loaded = Object.values(browser.levels).reduce(
    (n, l) => n + l.entries.filter((e) => e.kind === 'file').length,
    0,
  )
  const count =
    mode === 'name' ? (needle ? (browser.names?.files.length ?? 0) : loaded) : needle ? browser.hits.length : 0
  const summary = !needle
    ? mode === 'name'
      ? t('已读取 {n} 个文件', { n: count })
      : ''
    : mode === 'name'
      ? browser.namesLoading
        ? t('搜索中…')
        : t('找到 {n} 个', { n: count })
      : browser.searching
        ? t('搜索中…')
        : count
          ? t('{n} 个文件有匹配', { n: count })
          : ''

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
          <span className="ml-auto truncate text-[0.75rem] text-subtle">{summary}</span>
        </div>
      </div>

      <div className={cn('min-h-0 flex-1 overflow-auto py-2', compact ? 'px-1' : 'px-2 md:px-3')}>
        {/* 空白处右键：只作用于整棵树，不碰具体文件 */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="min-h-full">
              {browser.error && !browser.info ? (
                <p className="p-4 text-[0.8125rem] text-danger">{browser.error}</p>
              ) : browser.loading && !browser.info ? (
                <div className="flex justify-center p-8 text-subtle">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : mode === 'content' ? (
                <ContentResults
                  hits={browser.hits}
                  truncated={browser.hitsTruncated}
                  query={query}
                  searching={browser.searching}
                  onOpen={onOpen}
                  browser={browser}
                  compact={compact}
                />
              ) : needle ? (
                <NameResults
                  result={browser.names}
                  loading={browser.namesLoading}
                  error={browser.namesError}
                  query={needle}
                  onOpen={onOpen}
                  browser={browser}
                  compact={compact}
                />
              ) : (
                <>
                  {browser.error && (
                    <LevelError
                      path=""
                      depth={0}
                      error={browser.error}
                      browser={browser}
                      compact={compact}
                      onRetry={browser.refresh}
                    />
                  )}
                  <LevelRows
                    path=""
                    depth={0}
                    open={open}
                    browser={browser}
                    onToggle={toggle}
                    onOpen={onOpen}
                    compact={compact}
                  />
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={browser.refresh}>
              <RefreshCw className="h-4 w-4" />
              {t('刷新')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!Object.keys(browser.levels).length} onSelect={expandAll}>
              <ChevronsUpDown className="h-4 w-4" />
              {t('全部展开')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!open.size} onSelect={collapseAll}>
              <ChevronsDownUp className="h-4 w-4" />
              {t('全部收起')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void copyText(browser.absolute(''))}>
              <Copy className="h-4 w-4" />
              {t('复制项目路径')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!browser.info} onSelect={() => browser.reveal()}>
              <FolderOpen className="h-4 w-4" />
              {t('在文件夹中打开')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </div>
  )
}

/** 一层里的条目；目录展开后递归读下一层 */
function LevelRows({
  path,
  depth,
  open,
  browser,
  onToggle,
  onOpen,
  compact,
}: {
  /** 这一层的相对目录，根目录是空字符串 */
  path: string
  depth: number
  open: Set<string>
  browser: FileBrowser
  onToggle: (p: string) => void
  onOpen: (path: string) => void
  compact?: boolean
}) {
  const level = browser.levels[path]
  const state = browser.levelState(path)
  // 展开这一层时才请求；根目录也是
  useEffect(() => {
    browser.load(path)
    // 只在层或刷新变化时请求
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [path, browser.version])
  const [shown, setShown] = useState(PAGE)
  const entries = level?.entries ?? []

  if (!level) {
    if (state.error)
      return <LevelError path={path} depth={depth} error={state.error} browser={browser} compact={compact} />
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-1 text-subtle"
        style={{ paddingLeft: `${depth * (compact ? 12 : 14) + 8}px` }}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="text-[0.75rem]">{t('读取中…')}</span>
      </div>
    )
  }

  return (
    <>
      {state.error && <LevelError path={path} depth={depth} error={state.error} browser={browser} compact={compact} />}
      {level.statusSkipped && depth === 0 && (
        <p className="px-2 py-1 text-[0.6875rem] text-subtle">{t('这次没拿到 git 状态，文件照常列出。')}</p>
      )}
      {entries.slice(0, shown).map((e) => {
        const isOpen = e.kind === 'dir' && open.has(e.path)
        const Icon = e.kind === 'dir' ? (isOpen ? FolderOpen : Folder) : iconOf(e.path)
        const status = e.kind === 'file' && e.status ? STATUS[e.status] : undefined
        return (
          <div key={e.path}>
            <ContextMenu>
              {/* 内层菜单接管这一行的右键；不把事件交给外面空白处的菜单 */}
              <ContextMenuTrigger asChild onContextMenu={(ev) => ev.stopPropagation()}>
                <button
                  onClick={() => (e.kind === 'dir' ? onToggle(e.path) : onOpen(e.path))}
                  // 右键按住这一行拖到输入框里：左键还是打开 / 展开，不抢左键
                  onPointerDown={(ev) => {
                    if (ev.button === 2) startFileDrag({ path: e.path, kind: e.kind }, { x: ev.clientX, y: ev.clientY })
                  }}
                  // 缩进跟着层级走
                  style={{ paddingLeft: `${depth * (compact ? 12 : 14) + 8}px` }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-1.5 rounded pr-2 text-left text-[0.8125rem] hover:bg-sel',
                    compact ? 'h-6' : 'h-7',
                    e.kind === 'dir' ? 'text-fg' : 'text-muted hover:text-fg',
                  )}
                  title={e.path}
                >
                  {e.kind === 'dir' ? (
                    isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    )
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', e.kind === 'dir' ? 'text-accent/80' : 'text-subtle')} />
                  <span className={cn('min-w-0 truncate font-mono', compact ? 'text-[0.75rem]' : 'text-[0.78125rem]')}>
                    {e.name}
                  </span>
                  {status && (
                    <span className={cn('ml-auto shrink-0 font-mono text-[0.6875rem]', status.className)}>
                      {status.label}
                    </span>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {e.kind === 'dir' ? (
                  <ContextMenuItem onSelect={() => onToggle(e.path)}>
                    {isOpen ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                    {isOpen ? t('折叠') : t('展开')}
                  </ContextMenuItem>
                ) : (
                  <ContextMenuItem onSelect={() => onOpen(e.path)}>
                    <FileText className="h-4 w-4" />
                    {t('打开')}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void copyText(e.path)}>
                  <Copy className="h-4 w-4" />
                  {t('复制相对路径')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void copyText(browser.absolute(e.path))}>
                  <Copy className="h-4 w-4" />
                  {t('复制绝对路径')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => browser.reveal(e.path)}>
                  <FolderOpen className="h-4 w-4" />
                  {t('在文件夹中打开')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {isOpen && (
              <LevelRows
                path={e.path}
                depth={depth + 1}
                open={open}
                browser={browser}
                onToggle={onToggle}
                onOpen={onOpen}
                compact={compact}
              />
            )}
          </div>
        )
      })}
      {entries.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          style={{ paddingLeft: `${depth * (compact ? 12 : 14) + 8}px` }}
          className={cn(
            'flex w-full cursor-pointer items-center rounded pr-2 text-left text-[0.75rem] text-accent hover:bg-sel',
            compact ? 'h-6' : 'h-7',
          )}
        >
          {t('显示更多（还有 {n} 项）', { n: entries.length - shown })}
        </button>
      )}
      {!entries.length && depth === 0 && (
        <p className="p-4 text-[0.8125rem] text-subtle">{t('这个目录里没有文件。')}</p>
      )}
    </>
  )
}

/** 这一层读失败了：显示原因和重试。已有旧数据时排在旧内容上方，不把树整块换掉 */
function LevelError({
  path,
  depth,
  error,
  browser,
  compact,
  onRetry,
}: {
  path: string
  depth: number
  error: string
  browser: FileBrowser
  compact?: boolean
  /** 根信息和目录层的重试动作不一样：根信息要整轮重读，目录只重读这一层 */
  onRetry?: () => void
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1" style={{ paddingLeft: `${depth * (compact ? 12 : 14) + 8}px` }}>
      <span className="min-w-0 flex-1 truncate text-[0.75rem] text-danger">{error}</span>
      <button
        type="button"
        onClick={onRetry ?? (() => browser.load(path))}
        className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[0.75rem] text-accent hover:bg-sel"
      >
        {t('重试')}
      </button>
    </div>
  )
}

/** 搜索命中的文件行：右键菜单和数据源一致（打开、复制路径、在文件夹中打开） */
function FileRow({
  path,
  browser,
  onOpen,
  children,
  className,
}: {
  path: string
  browser: FileBrowser
  onOpen: (path: string, line?: number) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(ev) => ev.stopPropagation()}>
        <button
          type="button"
          onClick={() => onOpen(path)}
          // 搜索结果也是文件行，一样能右键拖进输入框
          onPointerDown={(ev) => {
            if (ev.button === 2) startFileDrag({ path, kind: 'file' }, { x: ev.clientX, y: ev.clientY })
          }}
          className={className}
          title={path}
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(path)}>
          <FileText className="h-4 w-4" />
          {t('打开')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copyText(path)}>
          <Copy className="h-4 w-4" />
          {t('复制相对路径')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyText(browser.absolute(path))}>
          <Copy className="h-4 w-4" />
          {t('复制绝对路径')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => browser.reveal(path)}>
          <FolderOpen className="h-4 w-4" />
          {t('在文件夹中打开')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 按文件名搜索的结果：直接平铺，不用把整棵树都展开 */
function NameResults({
  result,
  loading,
  error,
  query,
  onOpen,
  browser,
  compact,
}: {
  result: NameSearch | null
  loading: boolean
  error: string
  query: string
  onOpen: (path: string, line?: number) => void
  browser: FileBrowser
  compact?: boolean
}) {
  if (loading && !result)
    return (
      <div className="flex justify-center p-8 text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  if (error) return <p className="p-4 text-[0.8125rem] text-danger">{error}</p>
  if (!result?.files.length) return <p className="p-4 text-[0.8125rem] text-subtle">{t('没有匹配的文件。')}</p>
  const needle = query.toLowerCase()
  return (
    <div className="flex flex-col">
      {result.files.map((f) => {
        const Icon = iconOf(f.path)
        const status = f.status ? STATUS[f.status] : undefined
        const name = f.path.slice(f.path.lastIndexOf('/') + 1)
        const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1)
        return (
          <FileRow
            key={f.path}
            path={f.path}
            browser={browser}
            onOpen={onOpen}
            className={cn(
              'flex w-full cursor-pointer items-center gap-1.5 rounded px-2 text-left hover:bg-sel',
              compact ? 'h-6' : 'h-7',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span
              className={cn('min-w-0 truncate font-mono text-muted', compact ? 'text-[0.75rem]' : 'text-[0.78125rem]')}
            >
              <Highlight text={name} needle={needle} />
            </span>
            {dir && <span className="min-w-0 truncate font-mono text-[0.6875rem] text-subtle">{dir.slice(0, -1)}</span>}
            {status && (
              <span className={cn('ml-auto shrink-0 font-mono text-[0.6875rem]', status.className)}>
                {status.label}
              </span>
            )}
          </FileRow>
        )
      })}
      {result.truncated && <p className="px-2 py-3 text-xs text-subtle">{t('匹配太多，只显示了前面一部分。')}</p>}
    </div>
  )
}

/** 按内容搜索的结果：每个文件一组，下面列出命中的行 */
function ContentResults({
  hits,
  truncated,
  query,
  searching,
  onOpen,
  browser,
  compact,
}: {
  hits: ContentFile[]
  truncated: boolean
  query: string
  searching: boolean
  onOpen: (path: string, line?: number) => void
  browser: FileBrowser
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
            <FileRow
              path={f.path}
              browser={browser}
              onOpen={(p) => onOpen(p, f.hits[0]?.line)}
              className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-2 text-left hover:bg-sel"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className={cn('min-w-0 truncate font-mono', compact ? 'text-[0.75rem]' : 'text-[0.78125rem]')}>
                {f.path}
              </span>
              <span className="ml-auto shrink-0 text-[0.6875rem] text-subtle">{f.hits.length}</span>
            </FileRow>
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
