import { useEffect, useMemo, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Code2, Columns2, Copy, FolderOpen, List, Loader2, Undo2, WrapText, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Task } from '@shared/schema'
import type { FileDiff } from '@shared/files'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { editorUrl } from '@/lib/editor-url'
import { useScopedSetting } from '@/lib/useScopedSetting'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { numbered, sideBySide } from './diff-rows'

type Diff = Awaited<ReturnType<typeof api.taskDiff>>

/** 折行时的排版：保留缩进和连续空格，超长的路径、URL 也能在任意位置断开 */
const WRAP = 'whitespace-pre-wrap wrap-anywhere'

/**
 * 左右对照：左边改前、右边改后；配对的两行都变了才标红标绿，只在一侧出现的是删除或新增。
 * 折行时两列各占一半、内容各自折行，左右靠网格行对齐（左边折成几行时，右边同一逻辑行仍在同一行里）。
 * 不折行时两列按内容撑开，整块横向滚动看原样（新增文件的左栏只占行号那一列的宽度，不白占一半）。
 * 缺失的一侧只留中性底色：新增文件整条左栏是空的，染成红色会被当成整段删除。
 */
function SplitView({ lines, wrap }: { lines: string[]; wrap: boolean }) {
  // 配对只在差异内容变了才重算：切折行开关不该把上千行重新排一遍
  const rows = useMemo(() => sideBySide(lines), [lines])
  return (
    <div className={cn('font-mono text-[0.78125rem] leading-[1.6]', !wrap && 'min-w-max')}>
      <div className={cn('grid', wrap ? 'grid-cols-2' : 'grid-cols-[max-content_max-content]')}>
        {rows.map((r, i) => {
          if (r.kind === 'hunk')
            return (
              <div
                key={i}
                className={cn('col-span-2 bg-field px-3 py-0.5 text-subtle', wrap ? WRAP : 'whitespace-pre')}
              >
                {r.l}
              </div>
            )
          if (r.kind === 'note')
            return (
              <div key={i} className={cn('col-span-2 px-3 py-0.5 text-subtle/70', wrap ? WRAP : 'whitespace-pre')}>
                {r.l}
              </div>
            )
          const changed = !!r.left && !!r.right
          const cell = (side: 'left' | 'right') => {
            const c = side === 'left' ? r.left : r.right
            const tone = !c
              ? 'bg-field/40'
              : changed
                ? side === 'left'
                  ? 'bg-danger/10 text-danger'
                  : 'bg-success/10 text-success'
                : 'text-muted'
            return (
              <div
                key={`${i}-${side}`}
                className={cn(
                  'flex',
                  wrap ? `min-w-0 ${WRAP}` : 'whitespace-pre',
                  tone,
                  side === 'left' && 'border-r border-line',
                )}
              >
                {/* 行号列固定宽度：折行时只有内容往下走，行号不跟着挪位 */}
                <span className="w-11 shrink-0 pr-2 text-right text-subtle/70 select-none">{c?.n ?? ''}</span>
                <span className={cn('pr-4', wrap && `min-w-0 flex-1 ${WRAP}`)}>{c ? c.l || ' ' : ''}</span>
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
 * 长行默认折行（不再横向滚动），可以切回不折行看原样。两个选择都记在浏览器里，下次打开沿用上次的
 */
function DiffBody({ diff }: { diff: string }) {
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
  // 同理：行号也只跟差异内容走，切开关和切模式时复用
  const rows = useMemo(() => numbered(lines), [lines])
  return (
    <>
      <div className="sticky top-0 z-10 flex items-center justify-end gap-1 border-b bg-card/95 px-3 py-1.5 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={wrap}
          title={wrap ? t('长行折行显示') : t('长行不折行，可以左右滚动')}
          onClick={() => setWrap(!wrap)}
          className={cn(wrap && 'bg-sel text-fg')}
        >
          <WrapText className="h-4 w-4" />
          {t('折行')}
        </Button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
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
        <SplitView lines={lines} wrap={wrap} />
      ) : (
        <pre className={cn('py-2 font-mono text-[0.78125rem] leading-[1.6]', !wrap && 'min-w-max')}>
          {rows.map(({ l, cls, a, b }, i) => (
            <div key={i} className={cn('flex', wrap ? WRAP : 'whitespace-pre', cls)}>
              {/* 改前、改后的行号，参照 Claude Code 的差异显示；宽度固定，折行时不跟着挪位 */}
              <span className="w-11 shrink-0 pr-2 text-right text-subtle/70 select-none">{a ?? ''}</span>
              <span className="w-11 shrink-0 pr-3 text-right text-subtle/70 select-none">{b ?? ''}</span>
              <span className={cn('pr-4', wrap && `min-w-0 flex-1 ${WRAP}`)}>{l || ' '}</span>
            </div>
          ))}
        </pre>
      )}
    </>
  )
}

/**
 * 弹窗里的滚动内容区。
 * 底色铺满整个内容区（连下沿的圆角一起），滚动区本身退到离下沿一个圆角的高度，
 * 这样横向、纵向滚动条都只出现在直边上，不会压进 rounded-2xl 的两个下圆角。
 * 三个弹窗都用它，尺寸和圆角才对得上。
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
          <DialogScroll>
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
          </DialogScroll>
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
          <DialogScroll>
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
          </DialogScroll>
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
