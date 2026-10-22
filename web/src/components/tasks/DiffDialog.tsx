import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Code2, Columns2, Copy, FolderOpen, List, Loader2, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { editorUrl } from '@/lib/editor-url'
import { useScopedSetting } from '@/lib/useScopedSetting'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'

type Diff = Awaited<ReturnType<typeof api.taskDiff>>

/** 一行差异的样式：新增绿、删除红、块头灰，文件头不显示 */
function lineClass(l: string) {
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) return null
  if (l.startsWith('new file') || l.startsWith('deleted file') || l.startsWith('similarity')) return null
  if (l.startsWith('@@')) return 'bg-field text-subtle'
  if (l.startsWith('+')) return 'bg-success/10 text-success'
  if (l.startsWith('-')) return 'bg-danger/10 text-danger'
  return 'text-muted'
}

/** 给每行配上改前、改后的行号（从 @@ -a,n +b,m @@ 推出来）；文件头那几行不显示 */
function numbered(lines: string[]) {
  let a = 0
  let b = 0
  const out: { l: string; cls: string; a?: number; b?: number }[] = []
  for (const l of lines) {
    const cls = lineClass(l)
    if (cls === null) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (h) {
      a = Number(h[1])
      b = Number(h[2])
      out.push({ l, cls })
    } else if (l.startsWith('+')) out.push({ l, cls, b: b++ })
    else if (l.startsWith('-')) out.push({ l, cls, a: a++ })
    else if (l.startsWith('\\')) out.push({ l, cls })
    else out.push({ l, cls, a: a++, b: b++ })
  }
  return out
}

type Row =
  | { kind: 'hunk'; l: string }
  | { kind: 'note'; l: string }
  | { kind: 'pair'; left?: { n: number; l: string }; right?: { n: number; l: string } }

/**
 * 把 unified diff 排成左右对照：一段连续的删行接一段连续的增行，按位置配对，多出来的那侧留空。
 * 行号沿用 @@ 里给的数，只用来显示
 */
function sideBySide(lines: string[]) {
  let a = 0
  let b = 0
  const out: Row[] = []
  // 连续的删行和增行先攒着，遇到上下文行或块结束时配对
  let dels: { n: number; l: string }[] = []
  let adds: { n: number; l: string }[] = []
  const flush = () => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) out.push({ kind: 'pair', left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (lineClass(l) === null) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (h) {
      flush()
      a = Number(h[1])
      b = Number(h[2])
      out.push({ kind: 'hunk', l })
    } else if (l.startsWith('-')) dels.push({ n: a++, l: l.slice(1) })
    else if (l.startsWith('+')) adds.push({ n: b++, l: l.slice(1) })
    else if (l.startsWith('\\')) {
      flush()
      out.push({ kind: 'note', l })
    } else {
      flush()
      const text = l.slice(1)
      out.push({ kind: 'pair', left: { n: a++, l: text }, right: { n: b++, l: text } })
    }
  }
  flush()
  return out
}

/**
 * 左右对照：左边改前、右边改后；配对的两行都变了才标红标绿，只在一侧出现的是删除或新增。
 * 两列各自按内容撑开、至少各占一半：长行只把整块撑宽（外面横向滚动），不会盖到另一边
 */
function SplitView({ lines }: { lines: string[] }) {
  return (
    <div className="min-w-max font-mono text-[0.78125rem] leading-[1.6]">
      <div className="grid grid-cols-[minmax(max-content,1fr)_minmax(max-content,1fr)]">
        {sideBySide(lines).map((r, i) => {
          if (r.kind === 'hunk')
            return (
              <div key={i} className="col-span-2 whitespace-pre bg-field px-3 py-0.5 text-subtle">
                {r.l}
              </div>
            )
          if (r.kind === 'note')
            return (
              <div key={i} className="col-span-2 whitespace-pre px-3 py-0.5 text-subtle/70">
                {r.l}
              </div>
            )
          const changed = !!r.left && !!r.right
          const cell = (side: 'left' | 'right') => {
            const c = side === 'left' ? r.left : r.right
            const tone = !c
              ? side === 'left'
                ? 'bg-danger/5'
                : 'bg-success/5'
              : changed
                ? side === 'left'
                  ? 'bg-danger/10 text-danger'
                  : 'bg-success/10 text-success'
                : 'text-muted'
            return (
              <div
                key={`${i}-${side}`}
                className={cn('flex whitespace-pre', tone, side === 'left' && 'border-r border-line')}
              >
                <span className="w-11 shrink-0 pr-2 text-right text-subtle/70 select-none">{c?.n ?? ''}</span>
                <span className="pr-4">{c ? c.l || ' ' : ''}</span>
              </div>
            )
          }
          return [cell('left'), cell('right')]
        })}
      </div>
    </div>
  )
}

/**
 * 差异正文：默认左右对照，可以切回上下对照（像 git diff 那样逐行看，横向更省地方）。
 * 选择记在浏览器里，下次打开沿用上次的
 */
function DiffBody({ diff }: { diff: string }) {
  const [mode, setMode] = useScopedSetting<'split' | 'unified'>(
    'diff-view',
    'default',
    (raw) => (raw === 'unified' ? 'unified' : 'split'),
    (v) => v,
  )
  const lines = diff.split('\n')
  return (
    <>
      <div className="sticky top-0 z-10 flex items-center justify-end gap-1 border-b bg-card/95 px-3 py-1.5 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={mode === 'split'}
          onClick={() => setMode('split')}
          className={cn(mode === 'split' && 'bg-sel text-fg')}
        >
          <Columns2 className="h-4 w-4" />
          {t('左右对照')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={mode === 'unified'}
          onClick={() => setMode('unified')}
          className={cn(mode === 'unified' && 'bg-sel text-fg')}
        >
          <List className="h-4 w-4" />
          {t('上下对照')}
        </Button>
      </div>
      {mode === 'split' ? (
        <SplitView lines={lines} />
      ) : (
        <pre className="min-w-max py-2 font-mono text-[0.78125rem] leading-[1.6]">
          {numbered(lines).map(({ l, cls, a, b }, i) => (
            <div key={i} className={cn('flex whitespace-pre', cls)}>
              {/* 改前、改后的行号，参照 Claude Code 的差异显示 */}
              <span className="w-11 shrink-0 pr-2 text-right text-subtle/70 select-none">{a ?? ''}</span>
              <span className="w-11 shrink-0 pr-3 text-right text-subtle/70 select-none">{b ?? ''}</span>
              <span className="pr-4">{l || ' '}</span>
            </div>
          ))}
        </pre>
      )}
    </>
  )
}

/** 项目文件页的「查看改动」：字段按后端的约定，note 是后端给的说明（不是 git 仓库、未跟踪文件这类） */
export type ProjectDiffData = {
  path: string
  dir: string
  diff: string
  git: boolean
  /** 改动前这个文件存不存在：后端没给就不解释 */
  before?: boolean
  /** 后端给的说明：有它又没有差异时直接显示这句，不拿空 diff 糊弄 */
  note?: string
}

/**
 * 项目里一个文件的改动：和任务里的差异共用一套渲染（左右 / 上下对照）。
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
  data: ProjectDiffData | null
  error: string
  onOpenChange: (open: boolean) => void
}) {
  const text = data?.diff ?? ''
  const note = (data?.note ?? '').trim()
  const shown = data?.path || path || ''
  return (
    <D.Root open={!!path} onOpenChange={onOpenChange}>
      <D.Portal>
        {/* 它总是从文件预览窗口里打开，层级要高过那个窗口 */}
        <D.Overlay className="fixed inset-0 z-[60] bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-[70] flex h-[min(900px,calc(100dvh-2rem))] w-[min(1440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <D.Title className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={shown}>
              {shown}
            </D.Title>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制路径')}
              title={t('复制路径')}
              onClick={() =>
                navigator.clipboard
                  ?.writeText(shown)
                  .then(() => toast.success(t('已复制')))
                  .catch(() => {})
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
            {data?.dir && shown && (
              <Button variant="ghost" size="sm" onClick={() => window.open(editorUrl(data.dir, shown))}>
                <Code2 className="h-4 w-4" />
                {t('在编辑器中打开')}
              </Button>
            )}
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')} title={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-(--code-bg)">
            {error ? (
              <p className="p-6 text-[0.8125rem] text-danger">{error}</p>
            ) : !data ? (
              <div className="flex h-full items-center justify-center text-subtle">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : note && !text.trim() ? (
              // 后端说明了为什么没有差异（不是 git 仓库、文件没被跟踪），照原话显示
              <p className="p-6 text-[0.8125rem] leading-relaxed text-subtle">{note}</p>
            ) : !text.trim() ? (
              <p className="p-6 text-[0.8125rem] text-subtle">
                {data.git ? t('这个文件还没有改动。') : t('项目不是 git 仓库，也没有拿到这个文件的改动内容。')}
              </p>
            ) : (
              <DiffBody diff={text} />
            )}
          </div>
          {note && text.trim() && <p className="shrink-0 border-t px-4 py-2 text-xs text-subtle">{note}</p>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/**
 * 差异窗口：默认左右对照，可以切到上下对照；窗口尽量占满屏幕。
 * - 给了 path：「更改」里点一个文件，看它和任务开始时相比改了什么，可以在编辑器里打开或撤销
 * - 给了 diff：工具行里的编辑记录，看这一次改了什么
 */
export function DiffDialog({
  task,
  path,
  diff,
  title,
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

  return (
    <D.Root open={own || !!path} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(900px,calc(100dvh-2rem))] w-[min(1440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <D.Title className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={shown}>
              {shown}
            </D.Title>
            {stamp && (
              <span className="shrink-0 font-mono text-xs">
                <span className="text-success">+{stamp.add}</span>
                {stamp.del > 0 && <span className="text-danger"> -{stamp.del}</span>}
              </span>
            )}
            {/* 路径后面直接给一个「打开所在文件夹」：找文件时不用先去编辑器里定位 */}
            {shown && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('打开所在文件夹')}
                title={t('打开所在文件夹')}
                onClick={() => api.revealTaskFile(task.id, shown).catch((e) => toast.error((e as Error).message))}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制路径')}
              title={t('复制路径')}
              onClick={() =>
                navigator.clipboard
                  ?.writeText(shown)
                  .then(() => toast.success(t('已复制')))
                  .catch(() => {})
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
            {!own && data?.dir && path && (
              <Button variant="ghost" size="sm" onClick={() => window.open(editorUrl(data.dir, path))}>
                <Code2 className="h-4 w-4" />
                {t('在编辑器中打开')}
              </Button>
            )}
            {!own && data?.git && (
              <Button
                variant="ghost"
                size="sm"
                disabled={running}
                title={running ? t('任务正在执行，停下后才能撤销') : t('恢复成任务开始时的样子')}
                onClick={() => setConfirm(true)}
              >
                <Undo2 className="h-4 w-4" />
                {t('撤销改动')}
              </Button>
            )}
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-(--code-bg)">
            {error ? (
              <p className="p-6 text-[0.8125rem] text-danger">{error}</p>
            ) : !ready ? (
              <div className="flex h-full items-center justify-center text-subtle">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : !text.trim() ? (
              <p className="p-6 text-[0.8125rem] text-subtle">
                {own
                  ? t('这次修改没有给出改动内容。')
                  : data?.git
                    ? t('和任务开始时相比没有差异。')
                    : t('项目不是 git 仓库，Agent 也没有给出这个文件的改动内容。')}
              </p>
            ) : (
              <DiffBody diff={text} />
            )}
          </div>
          {!own && data && !data.git && text.trim() && (
            <p className="shrink-0 border-t px-4 py-2 text-xs text-subtle">
              {t('项目不是 git 仓库：这里是 Agent 每次修改这个文件时给出的改动，按时间先后排列。')}
            </p>
          )}
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
