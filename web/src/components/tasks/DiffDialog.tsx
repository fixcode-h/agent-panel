import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Code2, Copy, Loader2, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
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

/** 编辑器里打开的地址（VS Code 及兼容的编辑器认 vscode://file/） */
const editorUrl = (dir: string, file: string) => {
  const full = `${dir.replace(/[\\/]+$/, '')}/${file}`.replace(/\\/g, '/')
  return `vscode://file/${full.startsWith('/') ? full.slice(1) : full}`
}

/**
 * 「更改」里点一个文件：看它和任务开始时相比改了什么，可以在编辑器里打开，或者撤销这个文件的改动。
 */
export function DiffDialog({
  task,
  path,
  onOpenChange,
  onReverted,
}: {
  task: Task
  path: string | null
  onOpenChange: (open: boolean) => void
  onReverted: (t: Task) => void
}) {
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  // 文件改动行数变了（Agent 又改了一次）就重新取
  const stamp = task.changes.find((c) => c.path === path)
  const key = `${path}|${stamp?.add}|${stamp?.del}`
  useEffect(() => {
    if (!path) return
    setError('')
    api
      .taskDiff(task.id, path)
      .then(setDiff)
      .catch((e) => setError((e as Error).message))
    // key 里已经包含 path
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, key])
  useEffect(() => {
    if (!path) setDiff(null)
  }, [path])

  const lines = (diff?.path === path ? diff.diff : '').split('\n')
  const running = task.status === 'running'
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
    <D.Root open={!!path} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(760px,calc(100dvh-2rem))] w-[min(1000px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <D.Title className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={path ?? ''}>
              {path}
            </D.Title>
            {stamp && (
              <span className="shrink-0 font-mono text-xs">
                <span className="text-success">+{stamp.add}</span>
                {stamp.del > 0 && <span className="text-danger"> -{stamp.del}</span>}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制路径')}
              title={t('复制路径')}
              onClick={() =>
                navigator.clipboard
                  ?.writeText(path ?? '')
                  .then(() => toast.success(t('已复制')))
                  .catch(() => {})
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
            {diff?.dir && path && (
              <Button variant="ghost" size="sm" onClick={() => window.open(editorUrl(diff.dir, path))}>
                <Code2 className="h-4 w-4" />
                {t('在编辑器中打开')}
              </Button>
            )}
            {diff?.git && (
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
            ) : !diff || diff.path !== path ? (
              <div className="flex h-full items-center justify-center text-subtle">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : !diff.diff.trim() ? (
              <p className="p-6 text-[0.8125rem] text-subtle">
                {diff.git
                  ? t('和任务开始时相比没有差异。')
                  : t('项目不是 git 仓库，Agent 也没有给出这个文件的改动内容。')}
              </p>
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
          </div>
          {diff && !diff.git && diff.diff.trim() && (
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
          diff?.before
            ? undefined
            : t('「{path}」会恢复成任务开始时的样子；任务里新建的文件会被删除。', { path: path ?? '' })
        }
        blocked={
          diff?.before ? t('这个文件在任务开始前就有没提交的改动，撤销会一起丢掉，请在编辑器里手动处理。') : undefined
        }
        confirmText={t('撤销')}
        onConfirm={revert}
      />
    </D.Root>
  )
}
