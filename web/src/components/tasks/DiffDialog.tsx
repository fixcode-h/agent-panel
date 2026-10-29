import { useEffect, useMemo, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import {
  ChevronDown,
  ChevronUp,
  Code2,
  Columns2,
  Copy,
  Ellipsis,
  FileText,
  FolderOpen,
  List,
  Loader2,
  Undo2,
  WrapText,
  X,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import type { Task } from '@shared/schema'
import type { FileDiff } from '@shared/files'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { editorUrl } from '@/lib/editor-url'
import { useScopedSetting } from '@/lib/useScopedSetting'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { DIFF_GUTTER, DIFF_HUNK, DIFF_TONE } from '@/components/ui/diff-tone'
import { diffStats, inlineDiff, numbered, sideBySide, type InlinePart, type NumberedLine, type Row } from './diff-rows'

type Diff = Awaited<ReturnType<typeof api.taskDiff>>

/** 折行时的排版：保留缩进和连续空格，超长的路径、URL 也能在任意位置断开 */
const WRAP = 'whitespace-pre-wrap wrap-anywhere'

/** 一次渲染的行数：几万行的 diff 一次铺出来会卡住界面，滚到底再接着加载下一批 */
const PAGE = 500

/** 弹窗本体：统一尺寸和圆角，两个差异窗口共用 */
const DIALOG =
  'fixed top-1/2 left-1/2 flex h-[min(900px,calc(100dvh-2rem))] w-[min(1440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none'

/** 工具栏右侧「更多」里的一项 */
interface MenuAction {
  label: string
  icon: React.ReactNode
  onSelect: () => void
  title?: string
  danger?: boolean
  disabled?: boolean
}

/** 把路径拆成目录和文件名：窄窗口时先截断目录，文件名始终看得见 */
function splitPath(p: string) {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}

/**
 * 差异窗口的头部和正文，两个弹窗共用。
 * 顶部一行是文件路径、增删统计和文件导航；下面一行是视图切换、折行和「更多」操作；
 * 正文单独滚动，长 diff 分批渲染，滚到底再加载下一批。
 */
function DiffShell({
  path,
  diff,
  stats,
  files,
  onNavigate,
  menu,
  close,
  empty,
  note,
}: {
  path: string
  /** 差异文本；空字符串表示没有内容，用 empty 说明原因 */
  diff: string
  /** 「改动」列表里已经算好的增删行数，优先于从 diff 里数出来的 */
  stats?: { add: number; del: number }
  /** 同一个列表里的文件，按这个顺序做上一个/下一个导航 */
  files?: string[]
  onNavigate?: (path: string) => void
  menu?: MenuAction[]
  /** 关闭按钮：外层用 Radix 的 Close 包好再传进来 */
  close?: React.ReactNode
  /** 没正文时显示什么（加载中、错误、空态） */
  empty?: React.ReactNode
  /** 正文下面的说明 */
  note?: string
}) {
  const [mode, setMode] = useScopedSetting<'split' | 'unified'>(
    'diff-view',
    'default',
    (raw) => (raw === 'unified' ? 'unified' : 'split'),
    (v) => v,
  )
  const [wrap, setWrap] = useScopedSetting<boolean>(
    'diff-wrap',
    'default',
    (raw) => raw !== 'nowrap',
    (v) => (v ? 'wrap' : 'nowrap'),
  )
  // 拆行只跟差异内容走：切折行开关、切对照模式时行数据不重算
  const lines = useMemo(() => diff.split('\n'), [diff])
  const rows = useMemo(() => sideBySide(lines), [lines])
  const plain = useMemo(() => numbered(lines), [lines])
  const counted = useMemo(() => diffStats(lines), [lines])
  // 空差异的判断要遍历整段文本：大 diff 每次重渲染都 trim 一遍太浪费
  const hasText = useMemo(() => diff.trim().length > 0, [diff])
  const scroll = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(PAGE)
  const { dir, name } = splitPath(path)
  const index = files && path ? files.indexOf(path) : -1
  const canNav = !!files && index >= 0 && files.length > 1 && !!onNavigate
  const total = mode === 'split' ? rows.length : plain.length
  const add = stats?.add ?? counted.add
  const del = stats?.del ?? counted.del

  // 换文件、换视图都从第一批重新显示：上一份 diff 的「已经在第几批」不该带到新文件上
  useEffect(() => {
    setShown(PAGE)
    if (scroll.current) scroll.current.scrollTop = 0
  }, [path, mode])

  // Alt + 上下方向键切文件：和按钮同一套顺序，键盘操作不用去点箭头
  useEffect(() => {
    if (!canNav) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const step = e.key === 'ArrowUp' ? -1 : 1
      const next = files![(index + step + files!.length) % files!.length]
      if (next && next !== path) {
        e.preventDefault()
        onNavigate!(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canNav, files, index, path, onNavigate])

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <D.Title
          className="m-0 flex min-w-0 flex-1 items-baseline gap-1 font-mono text-[0.8125rem] font-normal"
          title={path}
        >
          {dir && <span className="min-w-0 truncate text-subtle">{dir}</span>}
          <span className="max-w-[70%] shrink-0 truncate font-medium">{name || path}</span>
        </D.Title>
        {(hasText || stats) && (
          <span className="hidden shrink-0 items-center gap-1.5 font-mono text-[0.75rem] sm:flex">
            <span className="text-success">+{add}</span>
            <span className="text-danger">-{del}</span>
            {counted.hunks > 0 && <span className="text-subtle">· {t('{n} 处改动', { n: counted.hunks })}</span>}
          </span>
        )}
        {canNav && (
          <div className="flex shrink-0 items-center rounded-md bg-field p-0.5">
            <button
              type="button"
              aria-label={t('上一个文件')}
              title={t('上一个文件（Alt + ↑）')}
              onClick={() => onNavigate!(files![(index - 1 + files!.length) % files!.length])}
              className="grid h-5 w-5 cursor-pointer place-items-center rounded text-subtle transition-colors hover:bg-sel hover:text-fg"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <span className="px-1 font-mono text-[0.6875rem] text-subtle tabular-nums">
              {index + 1} / {files!.length}
            </span>
            <button
              type="button"
              aria-label={t('下一个文件')}
              title={t('下一个文件（Alt + ↓）')}
              onClick={() => onNavigate!(files![(index + 1) % files!.length])}
              className="grid h-5 w-5 cursor-pointer place-items-center rounded text-subtle transition-colors hover:bg-sel hover:text-fg"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {close}
      </header>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-card/95 px-2.5">
        <div role="radiogroup" aria-label={t('差异显示方式')} className="flex shrink-0 rounded-md bg-field p-0.5">
          {(
            [
              ['split', t('左右对照'), Columns2],
              ['unified', t('上下对照'), List],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              onClick={() => setMode(id)}
              className={cn(
                'flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 text-[0.6875rem] transition-colors',
                mode === id ? 'bg-card font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden />
        <button
          type="button"
          aria-pressed={wrap}
          title={wrap ? t('长行折行显示') : t('长行不折行，可以左右滚动')}
          onClick={() => setWrap(!wrap)}
          className={cn(
            'flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-[0.6875rem] transition-colors',
            wrap ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel hover:text-fg',
          )}
        >
          <WrapText className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">{t('折行')}</span>
        </button>
        {menu && menu.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center">
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('更多操作')} title={t('更多操作')}>
                  <Ellipsis className="h-4 w-4" />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {menu.map((m) => (
                  <MenuItem key={m.label} disabled={m.disabled} title={m.title} danger={m.danger} onSelect={m.onSelect}>
                    {m.icon}
                    {m.label}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
        )}
      </div>
      <div ref={scroll} className="min-h-0 flex-1 overflow-auto bg-(--code-bg)">
        {hasText ? (
          mode === 'split' ? (
            <SplitView rows={rows} wrap={wrap} shown={shown} />
          ) : (
            <UnifiedView rows={plain} wrap={wrap} shown={shown} />
          )
        ) : (
          empty
        )}
        {hasText && total > shown && (
          <div className="flex justify-center border-t bg-card/80 py-2">
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-[0.75rem] text-accent-text transition-colors hover:bg-sel"
            >
              {t('显示更多（还有 {n} 行）', { n: total - shown })}
            </button>
          </div>
        )}
      </div>
      {note && <p className="shrink-0 border-t bg-card px-4 py-2 text-xs text-subtle">{note}</p>}
    </>
  )
}

/** 行内变化的那一小段：整行已经有底色，这里再深一层标出真正改了哪几个字 */
function Inline({ parts, side }: { parts: InlinePart[]; side: 'left' | 'right' }) {
  return (
    <>
      {parts.map((p, i) =>
        p.changed ? (
          <span key={i} data-diff-mark className={side === 'left' ? DIFF_TONE.del.mark : DIFF_TONE.add.mark}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

/**
 * 左右对照：两列严格等宽，每侧都有自己的行号列；整行按增删着色，修改行再标出行内变化。
 * 折行时两列各占一半、内容各自折行，左右靠网格行对齐；不折行时整块横向滚动，两列仍按同样宽度排。
 * 缺了一侧的行只留中性底色：新增文件整条左栏是空的，染成红色会被当成整段删除。
 */
function SplitView({ rows, wrap, shown }: { rows: Row[]; wrap: boolean; shown: number }) {
  // 不折行时两列的宽度：按最长的一行估（ch 是等宽字体的字宽），左右取同一个值才严格等宽
  const col = useMemo(() => {
    let n = 32
    for (const r of rows) {
      if (r.kind !== 'pair') continue
      // 极长的单行（压缩资源、单行 JSON）按 2000 字封顶：再宽滚动条也没法用，需要时切回折行
      n = Math.max(n, Math.min((r.left?.l.length ?? 0) + 6, 2000), Math.min((r.right?.l.length ?? 0) + 6, 2000))
    }
    return n
  }, [rows])
  return (
    <div className="font-mono text-[0.75rem] leading-[1.65]">
      <div className="grid grid-cols-2" style={wrap ? undefined : { width: `max(100%, ${col * 2}ch)` }}>
        {rows.slice(0, shown).map((r, i) => {
          if (r.kind === 'hunk')
            return (
              <div key={i} className={cn('col-span-2', DIFF_HUNK, wrap ? WRAP : 'whitespace-pre')}>
                {r.l}
              </div>
            )
          if (r.kind === 'note')
            return (
              <div
                key={i}
                className={cn(
                  'col-span-2 px-3 py-0.5 text-[0.75rem] text-subtle/70 italic',
                  wrap ? WRAP : 'whitespace-pre',
                )}
              >
                {r.l}
              </div>
            )
          const changed = !!r.left && !!r.right && r.left.l !== r.right.l
          const inline = changed ? inlineDiff(r.left!.l, r.right!.l) : null
          const cell = (side: 'left' | 'right', c?: { n: number; l: string }, other?: { n: number; l: string }) => {
            const tone = !c
              ? DIFF_TONE.none
              : !other || c.l !== other.l
                ? side === 'left'
                  ? DIFF_TONE.del
                  : DIFF_TONE.add
                : DIFF_TONE.ctx
            return (
              <div key={`${i}-${side}`} className={cn('flex min-w-0', wrap ? WRAP : 'whitespace-pre', tone.row)}>
                {/* 行号列固定宽度：折行时只有内容往下走，行号不跟着挪位；它的底色也是左右两栏的分界 */}
                <span className={cn(DIFF_GUTTER, tone.gutter)}>{c?.n ?? ''}</span>
                <span className={cn('min-w-0 flex-1 pr-4 pl-3', wrap && WRAP)}>
                  {c ? (
                    inline ? (
                      <Inline parts={side === 'left' ? inline.left : inline.right} side={side} />
                    ) : (
                      c.l || ' '
                    )
                  ) : (
                    ''
                  )}
                </span>
              </div>
            )
          }
          return [cell('left', r.left, r.right), cell('right', r.right, r.left)]
        })}
      </div>
    </div>
  )
}

/** 上下对照：旧行号、新行号、符号各一列，像 git diff 一样逐行看，窄窗口下横向更省地方 */
function UnifiedView({ rows, wrap, shown }: { rows: NumberedLine[]; wrap: boolean; shown: number }) {
  return (
    <div className={cn('font-mono text-[0.75rem] leading-[1.65]', !wrap && 'min-w-max')}>
      {rows.slice(0, shown).map((r, i) => {
        if (r.l.startsWith('@@'))
          return (
            <div key={i} className={cn(DIFF_HUNK, wrap ? WRAP : 'whitespace-pre')}>
              {r.l}
            </div>
          )
        if (r.l.startsWith('\\'))
          return (
            <div
              key={i}
              className={cn('px-3 py-0.5 text-[0.75rem] text-subtle/70 italic', wrap ? WRAP : 'whitespace-pre')}
            >
              {r.l}
            </div>
          )
        const tone = r.l.startsWith('+') ? DIFF_TONE.add : r.l.startsWith('-') ? DIFF_TONE.del : DIFF_TONE.ctx
        return (
          <div key={i} className={cn('flex', wrap ? WRAP : 'whitespace-pre', tone.row)}>
            <span className={cn(DIFF_GUTTER, tone.gutter)}>{r.a ?? ''}</span>
            <span className={cn(DIFF_GUTTER, tone.gutter)}>{r.b ?? ''}</span>
            <span className={cn('w-5 shrink-0 select-none text-center', tone.sign)}>
              {tone === DIFF_TONE.add ? '+' : tone === DIFF_TONE.del ? '-' : ' '}
            </span>
            <span className={cn('min-w-0 flex-1 pr-4', wrap && WRAP)}>{r.l.slice(1) || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 弹窗里的滚动内容区。
 * 底色铺满整个内容区（连下沿的圆角一起），滚动区本身退到离下沿一个圆角的高度，
 * 这样横向、纵向滚动条都只出现在直边上，不会压进 rounded-2xl 的两个下圆角。
 * 文件预览窗口用；两个差异窗口有自己的头部和滚动区（见 DiffShell）。
 */
export function DialogScroll({
  box,
  children,
}: {
  /** 需要滚动定位时（比如跳到某一行）要拿到的滚动容器 */
  box?: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--code-bg) pb-4">
      <div ref={box} className="min-h-0 flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}

/**
 * 项目里一个文件的改动（接口给的就是 FileDiff）：和任务里的差异共用一套渲染（左右 / 上下对照）。
 * 不提供撤销：项目页面不是任务，说不清「恢复到什么时候」。
 */
export function ProjectDiffDialog({
  path,
  data,
  error,
  onOpenChange,
}: {
  /** 要看的文件；null 时窗口关着 */
  path: string | null
  data: FileDiff | null
  error: string
  onOpenChange: (open: boolean) => void
}) {
  const text = data?.diff ?? ''
  const note = (data?.note ?? '').trim()
  const shown = data?.path || path || ''
  const copyPath = () => void copyText(shown, { done: t('已复制'), fail: false })
  const menu: MenuAction[] = []
  if (shown) menu.push({ label: t('复制路径'), icon: <Copy className="h-4 w-4" />, onSelect: copyPath })
  if (data?.dir && shown)
    menu.push({
      label: t('在编辑器中打开'),
      icon: <Code2 className="h-4 w-4" />,
      onSelect: () => window.open(editorUrl(data.dir, shown)),
    })
  return (
    <D.Root open={!!path} onOpenChange={onOpenChange}>
      <D.Portal>
        {/* 它总是从文件预览窗口里打开，层级要高过那个窗口 */}
        <D.Overlay className="fixed inset-0 z-[60] bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content aria-describedby={undefined} className={cn(DIALOG, 'z-[70]')}>
          <DiffShell
            path={shown}
            diff={text}
            menu={menu}
            close={
              <D.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('关闭')} title={t('关闭')}>
                  <X className="h-4 w-4" />
                </Button>
              </D.Close>
            }
            empty={
              error ? (
                <p className="p-6 text-[0.8125rem] text-danger">{error}</p>
              ) : !data ? (
                <div className="flex h-full items-center justify-center gap-2 text-[0.8125rem] text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('正在读取差异…')}
                </div>
              ) : note && !text.trim() ? (
                // 后端说明了为什么没有差异（不是 git 仓库、文件没被跟踪），照原话显示
                <p className="p-6 text-[0.8125rem] leading-relaxed text-subtle">{note}</p>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-[0.8125rem] text-subtle">
                  <FileText className="h-5 w-5" />
                  {data.git ? t('这个文件还没有改动。') : t('项目不是 git 仓库，也没有拿到这个文件的改动内容。')}
                </div>
              )
            }
            note={note && text.trim() ? note : undefined}
          />
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/**
 * 差异窗口：默认左右对照，可以切到上下对照；窗口尽量占满屏幕。
 * - 给了 path：「更改」里点一个文件，看它和任务开始时相比改了什么，可以在编辑器里打开或撤销
 * - 给了 diff：工具行里的编辑记录，看这一次改了什么
 * - 同时给了 files / onPathChange：可以在「更改」列表里上下切换文件，不用关掉窗口再点
 */
export function DiffDialog({
  task,
  path,
  diff,
  title,
  files,
  onPathChange,
  onOpenChange,
  onReverted,
}: {
  /** 只用到任务的 id、状态和改动列表：工具行里不传整个任务 */
  task: Pick<Task, 'id' | 'status' | 'changes'>
  path?: string | null
  /** 直接给出差异（工具行里的编辑记录）：不取任务级的差异，也没有撤销 */
  diff?: string
  /** 直接给出差异时窗口标题上的文件名 */
  title?: string
  /** 「更改」列表里的文件顺序，用来做上一个/下一个导航 */
  files?: string[]
  onPathChange?: (path: string) => void
  onOpenChange: (open: boolean) => void
  onReverted: (t: Task) => void
}) {
  const [data, setData] = useState<Diff | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  // 工具行给的差异：不请求接口，也没有撤销
  const own = diff !== undefined
  // 文件改动行数变了（Agent 又改了一次）就重新取
  const stamp = task.changes.find((c) => c.path === path)
  const key = `${path}|${stamp?.add}|${stamp?.del}`
  useEffect(() => {
    if (!path || own) return
    setError('')
    api
      .taskDiff(task.id, path)
      .then(setData)
      .catch((e) => setError((e as Error).message))
    // key 里已经包含 path
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, key, own])
  useEffect(() => {
    if (!path || own) setData(null)
  }, [path, own])

  const text = own ? (diff ?? '') : data && data.path === path ? data.diff : ''
  const ready = own || (!!data && data.path === path)
  const running = task.status === 'running'
  const shown = own ? (title ?? '') : (path ?? '')
  const revert = async () => {
    try {
      onReverted(await api.revertFile(task.id, path!))
      toast.success(t('已撤销「{path}」的改动', { path: path! }))
      setConfirm(false)
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const copyPath = () => void copyText(shown, { done: t('已复制'), fail: false })
  const menu: MenuAction[] = []
  if (shown) {
    menu.push({ label: t('复制路径'), icon: <Copy className="h-4 w-4" />, onSelect: copyPath })
    // 路径后面直接给一个「打开所在文件夹」：找文件时不用先去编辑器里定位
    menu.push({
      label: t('打开所在文件夹'),
      icon: <FolderOpen className="h-4 w-4" />,
      onSelect: () => api.revealTaskFile(task.id, shown).catch((e) => toast.error((e as Error).message)),
    })
  }
  if (!own && data?.dir && path)
    menu.push({
      label: t('在编辑器中打开'),
      icon: <Code2 className="h-4 w-4" />,
      onSelect: () => window.open(editorUrl(data.dir, path)),
    })
  if (!own && data?.git)
    menu.push({
      label: t('撤销改动'),
      icon: <Undo2 className="h-4 w-4" />,
      onSelect: () => setConfirm(true),
      danger: true,
      disabled: running,
      title: running ? t('任务正在执行，停下后才能撤销') : t('恢复成任务开始时的样子'),
    })

  return (
    <D.Root open={own || !!path} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content aria-describedby={undefined} className={cn(DIALOG, 'z-50')}>
          <DiffShell
            path={shown}
            diff={text}
            stats={stamp ? { add: stamp.add, del: stamp.del } : undefined}
            files={own ? undefined : files}
            onNavigate={own ? undefined : onPathChange}
            menu={menu}
            close={
              <D.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                  <X className="h-4 w-4" />
                </Button>
              </D.Close>
            }
            empty={
              error ? (
                <p className="p-6 text-[0.8125rem] text-danger">{error}</p>
              ) : !ready ? (
                <div className="flex h-full items-center justify-center gap-2 text-[0.8125rem] text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('正在读取差异…')}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-[0.8125rem] text-subtle">
                  <FileText className="h-5 w-5" />
                  {own
                    ? t('这次修改没有给出改动内容。')
                    : data?.git
                      ? t('和任务开始时相比没有差异。')
                      : t('项目不是 git 仓库，Agent 也没有给出这个文件的改动内容。')}
                </div>
              )
            }
            note={
              !own && data && !data.git && text.trim()
                ? t('项目不是 git 仓库：这里是 Agent 每次修改这个文件时给出的改动，按时间先后排列。')
                : undefined
            }
          />
        </D.Content>
      </D.Portal>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('撤销这个文件的改动？')}
        description={
          data?.before
            ? undefined
            : t('「{path}」会恢复成任务开始时的样子；任务里新建的文件会被删除。', { path: path ?? '' })
        }
        blocked={
          data?.before ? t('这个文件在任务开始前就有没提交的改动，撤销会一起丢掉，请在编辑器里手动处理。') : undefined
        }
        confirmText={t('撤销')}
        onConfirm={revert}
      />
    </D.Root>
  )
}
