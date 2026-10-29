import { Fragment, useEffect, useId, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  LocateFixed,
  Pencil,
  RefreshCw,
  Search,
  Trash,
  X,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import type { ContentFile, DirLevel, FileTree, NameSearch, SearchMode } from '@shared/files'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/copy-text'
import { fileIcon } from '@/lib/file-icon'
import { startFileDrag } from '@/lib/fileDrag'
import { Field, Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Segmented } from '@/components/ui/segmented'
import { Modal } from '@/components/ui/modal'
import { ConfirmDialog } from '@/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'

/** git 状态的颜色和文字 */
const STATUS: Record<string, { label: string; className: string }> = {
  M: { label: 'M', className: 'text-warn' },
  A: { label: 'A', className: 'text-success' },
  '?': { label: 'U', className: 'text-success' },
  D: { label: 'D', className: 'text-danger' },
  R: { label: 'R', className: 'text-accent-text' },
  U: { label: '!', className: 'text-danger' },
}

/** 一层里一次渲染这么多行，再多的点「显示更多」；几万个项的目录也不会一次建几万个 DOM */
const PAGE = 400

/** 缩进跟着层级走；几个地方都要算，统一放这里 */
const indent = (depth: number, compact?: boolean) => depth * (compact ? 12 : 14) + 8

/** 全部展开的上限：再深、再多就停下，避免一次发上千个请求把服务端和页面拖死 */
const EXPAND_DEPTH = 6
const EXPAND_DIRS = 300
const EXPAND_CONCURRENCY = 4

/** 相对路径所在的目录，根目录是空字符串 */
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** 路径的最后一段（文件名或目录名） */
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** 逐层目录：'a/b/c' → ['', 'a', 'a/b', 'a/b/c'] */
function chainOf(path: string) {
  const out = ['']
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part
    out.push(acc)
  }
  return out
}

/** 名字里不能有的东西：路径分隔符和 Windows 不认的字符，服务端也会拦，这里先给一句人话 */
function nameProblem(name: string) {
  if (!name) return t('名字不能为空')
  if (name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) return t('名字里不能有路径分隔符和 : * ? " < > |')
  return ''
}

/** 菜单里的复制：成功提示「已复制」，失败提示「复制失败」 */
const copyPath = (text: string) => copyText(text, { done: t('已复制'), fail: t('复制失败') })

/** 目录一层现在处于什么状态 */
export interface LevelState {
  /** 正在请求这一层：首次读取时显示「读取中…」；已有旧数据时只在后台重读，界面照常显示旧内容 */
  loading: boolean
  error: string
}

/**
 * 树上的写操作：只有项目文件页提供（任务右栏看的是任务目录，只读）。
 * 后端对应的接口没合进来时这里是 undefined，菜单据此不显示。
 */
export interface FileTreeOps {
  /** 在相对目录 dir 下新建文件，返回新路径 */
  createFile: (dir: string, name: string, content?: string) => Promise<{ path: string }>
  createDir: (dir: string, name: string) => Promise<{ path: string }>
  /** 改名，返回新路径 */
  rename: (path: string, name: string) => Promise<{ path: string }>
  remove: (path: string) => Promise<void>
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
  /**
   * 读一层；这一轮已经读过或正在读时不重复请求。
   * 返回这一层的数据（读失败时是 null）：递归展开、定位路径都要等每一层读完才知道下面有什么。
   */
  load: (path: string) => Promise<DirLevel | null>
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
  /** 内容搜索失败的原因：只在内容结果里显示，不混进根错误 */
  hitsError: string
  searching: boolean
  /** 输入关键词；内容是停顿一下后调用，页面自己发请求 */
  search: (q: string, mode: SearchMode) => void
  /** 在系统的文件管理器里打开文件或目录；不传路径时打开项目（任务）目录 */
  reveal: (path?: string) => void
  /** 相对路径对应的绝对路径，「复制绝对路径」用；拿不到时返回空串 */
  absolute: (path: string) => string
  /** 新建、重命名、删除；没有时不显示这四个菜单项 */
  ops?: FileTreeOps
}

/** 树上要弹窗的操作；path 对新建来说是目标目录，对改名和删除来说是目标本身 */
type OpsRequest = { kind: 'new-file' | 'new-dir' | 'rename' | 'delete'; path: string }

/** 行菜单里的写操作，没有 ops 时整组都不显示 */
interface OpsMenu {
  newFile: (dir: string) => void
  newDir: (dir: string) => void
  rename: (path: string) => void
  remove: (path: string) => void
}

/**
 * 搜索结果的行选择：↑↓ 在结果里移动，Enter 打开选中项，Home / End 到首尾。
 * 焦点留在列表容器上（aria-activedescendant 指向选中项），和树里真实移动焦点不一样。
 */
function useResultNav(count: number, onEnter: (index: number) => void, resetKey: string) {
  const id = useId()
  const [active, setActive] = useState(-1)
  // 换了关键词或结果条数变了，选中的位置重新从一开始
  useEffect(() => setActive(-1), [resetKey, count])
  // 选中项滚进视野：按 id 找元素，不用给每一行存 ref
  useEffect(() => {
    if (active < 0) return
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, id])
  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (!count) return
    const move = (i: number) => {
      ev.preventDefault()
      setActive(Math.max(0, Math.min(count - 1, i)))
    }
    switch (ev.key) {
      case 'ArrowDown':
        move(active < 0 ? 0 : active + 1)
        break
      case 'ArrowUp':
        move(active < 0 ? count - 1 : active - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(count - 1)
        break
      case 'Enter':
        ev.preventDefault()
        onEnter(active < 0 ? 0 : active)
        break
    }
  }
  return { id, active, setActive, onKeyDown }
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
  /** hitLines 是这个文件里全部命中的行号，弹窗拿它做「上一处 / 下一处」 */
  onOpen: (path: string, line?: number, hitLines?: number[]) => void
  className?: string
  /** 右栏里的窄版：字号紧一点，搜索结果少列几行，不显示路径栏 */
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('name')
  const [open, setOpen] = useState<Set<string>>(new Set())
  /** 当前定位到的路径：路径栏按它显示分段，树里的行按它标选中 */
  const [current, setCurrent] = useState('')
  const [expanding, setExpanding] = useState(false)
  const [expandNote, setExpandNote] = useState('')
  /** 全部展开的轮次：收起或重新展开时加一，旧的循环看到就停 */
  const expandRun = useRef(0)
  /** 要聚焦的行（刚展开的行还没渲染出来，下一帧再找） */
  const [focusAsk, setFocusAsk] = useState<string | null>(null)
  const [request, setRequest] = useState<OpsRequest | null>(null)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const tree = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)

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

  /** 树里现在能看到的行（按 DOM 顺序）：上下移动焦点就按这个顺序走 */
  const rows = () => Array.from(tree.current?.querySelectorAll<HTMLElement>('[data-file-row]') ?? [])

  /** 让某一行拿到焦点并滚进视野 */
  const focusRow = (path: string) => setFocusAsk(path)
  useEffect(() => {
    if (!focusAsk) return
    const el = rows().find((node) => node.dataset.path === focusAsk)
    if (el) {
      el.focus()
      el.scrollIntoView({ block: 'nearest' })
    }
    setFocusAsk(null)
    // 行可能刚因为 open 变化才渲染出来，所以两个都要看
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsk, open])

  /**
   * 定位到一个相对路径：逐层读出祖先目录，展开到它所在的位置并聚焦那一行。
   * 路径栏点分段、粘贴路径定位都用它；正在搜索时先退出搜索，否则树根本没渲染。
   */
  const goTo = async (raw: string) => {
    const target = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.?\/+/, '')
      .replace(/\/+$/, '')
    if (!target) return
    if (needle) setQuery('')
    const parent = parentOf(target)
    // 逐层读：没读过的层不知道里面有没有这个目录
    for (const path of chainOf(parent)) {
      const level = await browser.load(path)
      if (!level) {
        toast.error(t('读不到「{path}」，可能已经被移动或删除', { path }))
        return
      }
    }
    const entry = browser.levels[parent]?.entries.find((e) => e.path === target)
    if (!entry) {
      toast.error(t('没有找到「{path}」', { path: target }))
      return
    }
    // 目录本身也展开，文件只展开到它所在的那一层
    const chain = chainOf(entry.kind === 'dir' ? target : parent)
    setOpen((prev) => new Set([...prev, ...chain]))
    setCurrent(target)
    focusRow(target)
  }

  /**
   * 全部展开：逐层递归展开，同一层最多 4 个请求同时进行。
   * 深度超过 EXPAND_DEPTH 层、目录超过 EXPAND_DIRS 个就停下，并用一行提示告诉用户；
   * 全部收起只清展开状态，缓存留着。
   */
  const expandAll = async () => {
    const run = ++expandRun.current
    setExpanding(true)
    setExpandNote('')
    const opened = new Set(open)
    let dirs = 0
    // 撞到上限的原因；用一个数组装，避免在闭包里改标量后类型被收窄成字面量
    const caps: ('depth' | 'dirs')[] = []
    // 广度优先：读完一层再读下一层，层的概念正好对上深度上限
    let frontier = ['']
    for (let depth = 0; frontier.length && !caps.length; depth++) {
      const next: string[] = []
      for (let i = 0; i < frontier.length; i += EXPAND_CONCURRENCY) {
        const batch = frontier.slice(i, i + EXPAND_CONCURRENCY)
        const levels = await Promise.all(batch.map((path) => browser.load(path)))
        // 期间点了全部收起或者又点了一次全部展开：这次的结果作废
        if (run !== expandRun.current) return
        levels.forEach((level) => {
          if (!level) return
          // 这一层的目录在第 depth + 1 层，到顶就不再往下
          if (depth + 1 > EXPAND_DEPTH) {
            if (!caps.includes('depth')) caps.push('depth')
            return
          }
          for (const e of level.entries) {
            if (e.kind !== 'dir') continue
            if (dirs >= EXPAND_DIRS) {
              if (!caps.includes('dirs')) caps.push('dirs')
              return
            }
            dirs += 1
            opened.add(e.path)
            next.push(e.path)
          }
        })
        // 边展开边显示，大项目也能看到进度
        setOpen(new Set(opened))
      }
      frontier = next
    }
    if (run !== expandRun.current) return
    setOpen(new Set(opened))
    setExpanding(false)
    if (caps.includes('dirs'))
      setExpandNote(t('目录太多，只展开了前 {n} 个；更深的目录可以自己点开', { n: EXPAND_DIRS }))
    else if (caps.includes('depth')) setExpandNote(t('已展开到第 {n} 层，更深的没有继续展开', { n: EXPAND_DEPTH }))
  }
  const collapseAll = () => {
    expandRun.current += 1
    setExpanding(false)
    setExpandNote('')
    setOpen(new Set())
  }

  /** 树容器的键盘操作：焦点在行上，按方向键在可见行间移动 */
  const onTreeKey = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const list = rows()
    if (!list.length) return
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const at = focused && focused.hasAttribute('data-file-row') ? list.indexOf(focused) : -1
    // 焦点不在任何行上（在容器上）时，方向键从第一行开始
    const index = at < 0 ? 0 : at
    const depthOf = (el: HTMLElement) => Number(el.dataset.depth ?? 0)
    const go = (i: number) => {
      const el = list[Math.max(0, Math.min(list.length - 1, i))]
      if (!el) return
      el.focus()
      el.scrollIntoView({ block: 'nearest' })
    }
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        go(at < 0 ? 0 : at + 1)
        return
      case 'ArrowUp':
        ev.preventDefault()
        go(at < 0 ? list.length - 1 : at - 1)
        return
      case 'Home':
        ev.preventDefault()
        go(0)
        return
      case 'End':
        ev.preventDefault()
        go(list.length - 1)
        return
      case 'ArrowRight': {
        ev.preventDefault()
        const el = list[index]
        if (el.dataset.kind !== 'dir') return
        // 收起状态先展开，已经展开就进到第一个子项
        if (el.getAttribute('aria-expanded') !== 'true') {
          el.click()
          return
        }
        const next = list[index + 1]
        if (next && depthOf(next) > depthOf(el)) go(index + 1)
        return
      }
      case 'ArrowLeft': {
        ev.preventDefault()
        const el = list[index]
        if (el.dataset.kind === 'dir' && el.getAttribute('aria-expanded') === 'true') {
          el.click()
          return
        }
        // 文件或已经收起的目录：回到上一个更浅的行，也就是它的父项
        for (let i = at - 1; i >= 0; i--)
          if (depthOf(list[i]) < depthOf(el)) {
            go(i)
            return
          }
        return
      }
      case 'Enter':
        ev.preventDefault()
        list[at]?.click()
        return
      case ' ':
        // 空格只切换目录；文件不在这里打开，免得和滚动撞上
        if (list[at]?.dataset.kind === 'dir') {
          ev.preventDefault()
          list[at].click()
        }
        return
    }
  }

  /** 搜索框快捷入口：/ 和 Ctrl(Cmd)+F；输入框里不拦截 */
  const onRootKey = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ev.target as HTMLElement
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return
    if (ev.key === '/' || ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f')) {
      ev.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
  }

  const askNew = (dir: string, kind: 'new-file' | 'new-dir') => {
    setRequest({ kind, path: dir })
    setName('')
    setNameError('')
  }
  const askRename = (path: string) => {
    setRequest({ kind: 'rename', path })
    setName(baseOf(path))
    setNameError('')
  }
  const askDelete = (path: string) => setRequest({ kind: 'delete', path })

  const opsMenu: OpsMenu | undefined = browser.ops
    ? {
        newFile: (dir) => askNew(dir, 'new-file'),
        newDir: (dir) => askNew(dir, 'new-dir'),
        rename: askRename,
        remove: askDelete,
      }
    : undefined

  /** 名字弹窗里点确定：成功后关窗，失败把服务端的原始错误显示出来（不静默重试） */
  const submitName = async () => {
    const ops = browser.ops
    const req = request
    if (!ops || !req || req.kind === 'delete') return
    const value = name.trim()
    const problem = nameProblem(value)
    if (problem) {
      setNameError(problem)
      return
    }
    setBusy(true)
    try {
      if (req.kind === 'rename') await ops.rename(req.path, value)
      else if (req.kind === 'new-file') await ops.createFile(req.path, value)
      else await ops.createDir(req.path, value)
      // 新建后把目标目录展开，新条目直接能看到
      if (req.kind !== 'rename') setOpen((prev) => new Set(prev).add(req.path))
      setRequest(null)
      setName('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const closeName = () => {
    setRequest(null)
    setName('')
    setNameError('')
  }

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
    <div ref={root} className={cn('flex min-h-0 flex-1 flex-col', className)} onKeyDown={onRootKey}>
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
            onKeyDown={(e) => {
              // 打完关键词按 ↓ 直接进结果列表，不用先 Tab 过去
              if (e.key === 'ArrowDown') root.current?.querySelector<HTMLElement>('[data-results]')?.focus()
            }}
            placeholder={mode === 'name' ? t('查找文件') : t('搜索文件内容')}
            className={cn('pl-8.5', compact ? 'h-7 text-[0.75rem]' : 'h-9')}
            aria-label={mode === 'name' ? t('查找文件') : t('搜索文件内容')}
          />
          {query && (
            <IconButton
              icon={X}
              label={t('清除搜索')}
              size="2xs"
              onClick={() => {
                setQuery('')
                input.current?.focus()
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2"
            />
          )}
        </div>
        <div className="flex items-center gap-1">
          <Segmented
            label={t('搜索方式')}
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { id: 'name', label: t('名称') },
              { id: 'content', label: t('内容') },
            ]}
          />
          {/* 结果条数报给读屏：搜索是异步的，条数变化用户看不见 */}
          <span aria-live="polite" aria-atomic="true" className="ml-auto truncate text-[0.75rem] text-subtle">
            {summary}
          </span>
        </div>
        {!compact && browser.info && (
          <PathBar
            root={browser.info.dir}
            path={current}
            onPick={(p) => {
              // 跳到这一层：它自己展开，更深的收起
              setOpen(new Set(chainOf(p)))
              setCurrent(p)
              focusRow(p)
              void (async () => {
                for (const path of chainOf(p)) await browser.load(path)
              })()
            }}
            onLocate={(typed) => void goTo(typed)}
          />
        )}
      </div>

      <div className={cn('min-h-0 flex-1 overflow-auto py-2', compact ? 'px-1' : 'px-2 md:px-3')}>
        {/* 空白处右键：作用于整棵树，不碰具体文件 */}
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
                  error={browser.hitsError}
                  onRetry={() => browser.search(query, mode)}
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
                  {(expanding || expandNote) && (
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[0.6875rem] text-subtle">
                      {expanding && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
                      <span className="min-w-0 flex-1 truncate">{expanding ? t('正在展开…') : expandNote}</span>
                    </div>
                  )}
                  {/* role=tree + 行上的 treeitem：容器只有一个 Tab 停靠点，方向键在里面走 */}
                  <div
                    ref={tree}
                    role="tree"
                    aria-label={t('文件树')}
                    tabIndex={0}
                    onKeyDown={onTreeKey}
                    className="min-h-full rounded outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/50"
                  >
                    <LevelRows
                      path=""
                      depth={0}
                      open={open}
                      browser={browser}
                      onToggle={toggle}
                      onOpen={onOpen}
                      onFocusPath={setCurrent}
                      current={current}
                      ops={opsMenu}
                      compact={compact}
                    />
                  </div>
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={browser.refresh}>
              <RefreshCw className="h-4 w-4" />
              {t('刷新')}
            </ContextMenuItem>
            <ContextMenuItem disabled={expanding || !Object.keys(browser.levels).length} onSelect={expandAll}>
              <ChevronsUpDown className="h-4 w-4" />
              {t('全部展开')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!open.size} onSelect={collapseAll}>
              <ChevronsDownUp className="h-4 w-4" />
              {t('全部收起')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void copyPath(browser.absolute(''))}>
              <Copy className="h-4 w-4" />
              {t('复制项目路径')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!browser.info} onSelect={() => browser.reveal()}>
              <FolderOpen className="h-4 w-4" />
              {t('在文件夹中打开')}
            </ContextMenuItem>
            {opsMenu && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => opsMenu.newFile('')}>
                  <FilePlus className="h-4 w-4" />
                  {t('新建文件')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => opsMenu.newDir('')}>
                  <FolderPlus className="h-4 w-4" />
                  {t('新建文件夹')}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {/* 新建 / 改名用同一个弹窗：名字就地填，回车提交 */}
      <Modal
        open={!!request && request.kind !== 'delete'}
        onOpenChange={(o) => !o && closeName()}
        title={request?.kind === 'rename' ? t('重命名') : request?.kind === 'new-dir' ? t('新建文件夹') : t('新建文件')}
        footer={
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-subtle">
              {request?.path || t('根目录')}
            </span>
            <Button variant="secondary" onClick={closeName}>
              {t('取消')}
            </Button>
            <Button disabled={busy || !name.trim()} onClick={() => void submitName()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('确定')}
            </Button>
          </>
        }
      >
        <Field label={t('名字')} error={nameError}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitName()
              }
            }}
            placeholder={t('文件名或文件夹名')}
            aria-label={t('名字')}
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={request?.kind === 'delete'}
        title={t('删除')}
        description={t('「{path}」删除后无法恢复。', { path: request?.path ?? '' })}
        onOpenChange={(o) => !o && setRequest(null)}
        onConfirm={async () => {
          const ops = browser.ops
          const req = request
          if (!ops || !req) return
          try {
            await ops.remove(req.path)
            setRequest(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </div>
  )
}

/** 路径栏：当前所在位置的分段（点一下跳到那一层），右边可以粘贴一个相对路径定位过去 */
function PathBar({
  root,
  path,
  onPick,
  onLocate,
}: {
  /** 项目（任务）根目录的绝对路径，只取最后一段当根的名字 */
  root: string
  path: string
  onPick: (path: string) => void
  onLocate: (typed: string) => void
}) {
  // null 表示没在输入：点了定位图标才换成输入框
  const [typed, setTyped] = useState<string | null>(null)
  const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const crumbs = [{ label: rootName || t('根目录'), path: '' }]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part
    crumbs.push({ label: part, path: acc })
  }
  if (typed !== null)
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onLocate(typed)
              setTyped(null)
            } else if (e.key === 'Escape') setTyped(null)
          }}
          placeholder={t('粘贴相对路径后回车定位')}
          aria-label={t('定位路径')}
          className="h-7 font-mono text-[0.75rem]"
        />
        <IconButton icon={X} size="sm" label={t('取消')} onClick={() => setTyped(null)} />
      </div>
    )
  return (
    <div className="flex min-w-0 items-center gap-0.5 text-[0.75rem]">
      {crumbs.map((c, i) => (
        <Fragment key={c.path || '_root'}>
          {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-subtle" />}
          <button
            type="button"
            onClick={() => onPick(c.path)}
            title={c.path || rootName || t('根目录')}
            className={cn(
              'min-w-0 max-w-[10rem] cursor-pointer truncate rounded px-1 py-0.5 hover:bg-sel',
              i === crumbs.length - 1 ? 'text-fg' : 'text-muted',
            )}
          >
            {c.label}
          </button>
        </Fragment>
      ))}
      <IconButton
        icon={LocateFixed}
        label={t('定位路径')}
        size="2xs"
        onClick={() => setTyped('')}
        className="ml-auto"
      />
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
  onFocusPath,
  current,
  ops,
  compact,
}: {
  /** 这一层的相对目录，根目录是空字符串 */
  path: string
  depth: number
  open: Set<string>
  browser: FileBrowser
  onToggle: (p: string) => void
  onOpen: (path: string, line?: number, hitLines?: number[]) => void
  /** 行拿到焦点时记下位置：路径栏和选中样式都看它 */
  onFocusPath: (path: string) => void
  current: string
  /** 树操作菜单；没有时（任务右栏）不显示新建 / 改名 / 删除 */
  ops?: OpsMenu
  compact?: boolean
}) {
  const level = browser.levels[path]
  const state = browser.levelState(path)
  // 展开这一层时才请求；根目录也是
  useEffect(() => {
    void browser.load(path)
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
        style={{ paddingLeft: `${indent(depth, compact)}px` }}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="text-[0.75rem]">{t('读取中…')}</span>
      </div>
    )
  }

  return (
    <div role="group">
      {state.error && <LevelError path={path} depth={depth} error={state.error} browser={browser} compact={compact} />}
      {level.statusSkipped && depth === 0 && (
        <p className="px-2 py-1 text-[0.6875rem] text-subtle">{t('这次没拿到 git 状态，文件照常列出。')}</p>
      )}
      {entries.slice(0, shown).map((e) => {
        const isOpen = e.kind === 'dir' && open.has(e.path)
        const Icon = e.kind === 'dir' ? (isOpen ? FolderOpen : Folder) : fileIcon(e.path)
        const status = e.kind === 'file' && e.status ? STATUS[e.status] : undefined
        // 新建目标：目录行用它自己，文件行用它的父目录
        const dir = e.kind === 'dir' ? e.path : parentOf(e.path)
        return (
          <div key={e.path}>
            <ContextMenu>
              {/* 内层菜单接管这一行的右键；不把事件交给外面空白处的菜单 */}
              <ContextMenuTrigger asChild onContextMenu={(ev) => ev.stopPropagation()}>
                <button
                  type="button"
                  data-file-row=""
                  data-path={e.path}
                  data-kind={e.kind}
                  data-depth={depth}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={e.kind === 'dir' ? isOpen : undefined}
                  aria-selected={e.path === current}
                  // 只有容器是 Tab 停靠点，行靠方向键移动焦点
                  tabIndex={-1}
                  onClick={() => (e.kind === 'dir' ? onToggle(e.path) : onOpen(e.path))}
                  onFocus={() => onFocusPath(e.path)}
                  // 左键长按这一行拖到输入框里：短按还是打开 / 展开，右键还是菜单
                  onPointerDown={(ev) => startFileDrag({ path: e.path, kind: e.kind }, ev)}
                  style={{ paddingLeft: `${indent(depth, compact)}px` }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-1.5 rounded pr-2 text-left text-[0.8125rem] outline-none hover:bg-sel focus:bg-sel aria-selected:bg-sel/70',
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
                  <Icon
                    className={cn('h-3.5 w-3.5 shrink-0', e.kind === 'dir' ? 'text-accent-text/80' : 'text-subtle')}
                  />
                  <span className={cn('min-w-0 truncate font-mono', compact ? 'text-[0.75rem]' : 'text-[0.75rem]')}>
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
                <ContextMenuItem onSelect={() => void copyPath(e.name)}>
                  <Copy className="h-4 w-4" />
                  {t('复制文件名')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void copyPath(e.path)}>
                  <Copy className="h-4 w-4" />
                  {t('复制相对路径')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void copyPath(browser.absolute(e.path))}>
                  <Copy className="h-4 w-4" />
                  {t('复制绝对路径')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => browser.reveal(e.path)}>
                  <FolderOpen className="h-4 w-4" />
                  {t('在文件夹中打开')}
                </ContextMenuItem>
                {ops && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => ops.newFile(dir)}>
                      <FilePlus className="h-4 w-4" />
                      {t('新建文件')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => ops.newDir(dir)}>
                      <FolderPlus className="h-4 w-4" />
                      {t('新建文件夹')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => ops.rename(e.path)}>
                      <Pencil className="h-4 w-4" />
                      {t('重命名')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => ops.remove(e.path)}>
                      <Trash className="h-4 w-4" />
                      {t('删除')}
                    </ContextMenuItem>
                  </>
                )}
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
                onFocusPath={onFocusPath}
                current={current}
                ops={ops}
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
          style={{ paddingLeft: `${indent(depth, compact)}px` }}
          className={cn(
            'flex w-full cursor-pointer items-center rounded pr-2 text-left text-[0.75rem] text-accent-text hover:bg-sel',
            compact ? 'h-6' : 'h-7',
          )}
        >
          {t('显示更多（还有 {n} 项）', { n: entries.length - shown })}
        </button>
      )}
      {!entries.length && depth === 0 && (
        <p className="p-4 text-[0.8125rem] text-subtle">{t('这个目录里没有文件。')}</p>
      )}
    </div>
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
    <div className="flex items-center gap-2 px-2 py-1" style={{ paddingLeft: `${indent(depth, compact)}px` }}>
      <span className="min-w-0 flex-1 truncate text-[0.75rem] text-danger">{error}</span>
      <button
        type="button"
        onClick={onRetry ?? (() => void browser.load(path))}
        className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[0.75rem] text-accent-text hover:bg-sel"
      >
        {t('重试')}
      </button>
    </div>
  )
}

/** 搜索命中的文件行：右键菜单和数据源一致（打开、复制路径、在文件夹中打开） */
function FileRow({
  path,
  line,
  hitLines,
  browser,
  onOpen,
  children,
  className,
  option,
}: {
  path: string
  /** 打开时跳到的行号（内容搜索用） */
  line?: number
  /** 这个文件里全部命中的行号，交给弹窗做「上一处 / 下一处」 */
  hitLines?: number[]
  browser: FileBrowser
  onOpen: (path: string, line?: number, hitLines?: number[]) => void
  children: React.ReactNode
  className?: string
  /** 作为搜索结果列表项时的 aria 属性 */
  option?: { id: string; selected: boolean; onHover: () => void }
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(ev) => ev.stopPropagation()}>
        <button
          type="button"
          id={option?.id}
          role={option ? 'option' : undefined}
          aria-selected={option ? option.selected : undefined}
          onMouseEnter={option?.onHover}
          onClick={() => onOpen(path, line, hitLines)}
          // 搜索结果也是文件行，一样能左键长按拖进输入框
          onPointerDown={(ev) => startFileDrag({ path, kind: 'file' }, ev)}
          className={className}
          title={path}
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(path, line, hitLines)}>
          <FileText className="h-4 w-4" />
          {t('打开')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copyPath(baseOf(path))}>
          <Copy className="h-4 w-4" />
          {t('复制文件名')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyPath(path)}>
          <Copy className="h-4 w-4" />
          {t('复制相对路径')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyPath(browser.absolute(path))}>
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
  onOpen: (path: string, line?: number, hitLines?: number[]) => void
  browser: FileBrowser
  compact?: boolean
}) {
  const files = result?.files ?? []
  const { id, active, setActive, onKeyDown } = useResultNav(
    files.length,
    (i) => files[i] && onOpen(files[i].path),
    query,
  )
  if (loading && !result)
    return (
      <div className="flex justify-center p-8 text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  if (error) return <p className="p-4 text-[0.8125rem] text-danger">{error}</p>
  if (!files.length) return <p className="p-4 text-[0.8125rem] text-subtle">{t('没有匹配的文件。')}</p>
  const needle = query.toLowerCase()
  return (
    // 焦点留在列表上，↑↓ 换选中项，Enter 打开；读屏靠 aria-activedescendant 知道选中了哪一条
    <div
      role="listbox"
      data-results=""
      aria-label={t('搜索结果')}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      className="flex flex-col rounded outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/50"
    >
      {files.map((f, i) => {
        const Icon = fileIcon(f.path)
        const status = f.status ? STATUS[f.status] : undefined
        const name = baseOf(f.path)
        const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1)
        return (
          <FileRow
            key={f.path}
            path={f.path}
            browser={browser}
            onOpen={onOpen}
            option={{ id: `${id}-${i}`, selected: i === active, onHover: () => setActive(i) }}
            className={cn(
              'flex w-full cursor-pointer items-center gap-1.5 rounded px-2 text-left outline-none hover:bg-sel aria-selected:bg-sel',
              compact ? 'h-6' : 'h-7',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span
              className={cn('min-w-0 truncate font-mono text-muted', compact ? 'text-[0.75rem]' : 'text-[0.75rem]')}
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
      {result?.truncated && <p className="px-2 py-3 text-xs text-subtle">{t('匹配太多，只显示了前面一部分。')}</p>}
    </div>
  )
}

/** 内容结果里的一行：文件标题、命中的一行、或者「还有 n 处」 */
type ContentRow =
  | { key: string; kind: 'file'; file: ContentFile }
  | { key: string; kind: 'hit'; file: ContentFile; line: number; text: string }
  | { key: string; kind: 'more'; file: ContentFile; rest: number }

/** 按内容搜索的结果：每个文件一组，下面列出命中的行 */
function ContentResults({
  hits,
  truncated,
  error,
  onRetry,
  query,
  searching,
  onOpen,
  browser,
  compact,
}: {
  hits: ContentFile[]
  truncated: boolean
  /** 搜索失败的原因：只在这里显示，不会把整棵树换成报错 */
  error: string
  onRetry: () => void
  query: string
  searching: boolean
  onOpen: (path: string, line?: number, hitLines?: number[]) => void
  browser: FileBrowser
  compact?: boolean
}) {
  const show = compact ? 3 : 5
  const rows: ContentRow[] = []
  for (const f of hits) {
    rows.push({ key: `f:${f.path}`, kind: 'file', file: f })
    for (const h of f.hits.slice(0, show))
      rows.push({ key: `h:${f.path}:${h.line}`, kind: 'hit', file: f, line: h.line, text: h.text })
    if (f.hits.length > show) rows.push({ key: `m:${f.path}`, kind: 'more', file: f, rest: f.hits.length - show })
  }
  const linesOf = (f: ContentFile) => f.hits.map((h) => h.line)
  const open = (i: number) => {
    const row = rows[i]
    if (!row) return
    if (row.kind === 'hit') onOpen(row.file.path, row.line, linesOf(row.file))
    else onOpen(row.file.path, row.file.hits[0]?.line, linesOf(row.file))
  }
  const { id, active, setActive, onKeyDown } = useResultNav(rows.length, open, query)

  if (!query.trim()) return <p className="p-4 text-[0.8125rem] text-subtle">{t('输入关键词，搜索文件里的内容。')}</p>
  if (error)
    // 内容搜索失败：说清是搜索失败，并给一个重试，不能让用户以为是「没有匹配」
    return (
      <div className="flex items-start gap-2 p-4">
        <p className="min-w-0 flex-1 text-[0.8125rem] text-danger">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[0.75rem] text-accent-text hover:bg-sel"
        >
          {t('重试')}
        </button>
      </div>
    )
  if (searching && !hits.length)
    return (
      <div className="flex justify-center p-8 text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  if (!hits.length) return <p className="p-4 text-[0.8125rem] text-subtle">{t('没有匹配的内容。')}</p>
  const needle = query.trim().toLowerCase()
  return (
    <div
      role="listbox"
      data-results=""
      aria-label={t('搜索结果')}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      className="flex flex-col gap-1 rounded outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/50"
    >
      {rows.map((row, i) => {
        const option = { id: `${id}-${i}`, selected: i === active, onHover: () => setActive(i) }
        if (row.kind === 'hit')
          return (
            <button
              key={row.key}
              type="button"
              id={option.id}
              role="option"
              aria-selected={option.selected}
              onMouseEnter={option.onHover}
              onClick={() => open(i)}
              className="ml-5 flex cursor-pointer items-baseline gap-2 rounded py-0.5 pr-2 pl-1 text-left outline-none hover:bg-sel aria-selected:bg-sel"
            >
              <span className="w-8 shrink-0 text-right font-mono text-[0.6875rem] text-subtle/70 tabular-nums">
                {row.line}
              </span>
              <span className="min-w-0 truncate font-mono text-[0.75rem] text-muted">
                <Highlight text={row.text} needle={needle} />
              </span>
            </button>
          )
        if (row.kind === 'more')
          return (
            <button
              key={row.key}
              type="button"
              id={option.id}
              role="option"
              aria-selected={option.selected}
              onMouseEnter={option.onHover}
              onClick={() => open(i)}
              className="ml-5 cursor-pointer rounded py-0.5 pr-2 pl-1 text-left text-[0.6875rem] text-subtle outline-none hover:text-fg aria-selected:bg-sel"
            >
              {t('还有 {n} 处匹配', { n: row.rest })}
            </button>
          )
        const Icon = fileIcon(row.file.path)
        return (
          <FileRow
            key={row.key}
            path={row.file.path}
            hitLines={linesOf(row.file)}
            browser={browser}
            onOpen={onOpen}
            option={option}
            className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-2 text-left outline-none hover:bg-sel aria-selected:bg-sel"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className={cn('min-w-0 truncate font-mono', compact ? 'text-[0.75rem]' : 'text-[0.75rem]')}>
              {row.file.path}
            </span>
            <span className="ml-auto shrink-0 text-[0.6875rem] text-subtle">{row.file.hits.length}</span>
          </FileRow>
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
