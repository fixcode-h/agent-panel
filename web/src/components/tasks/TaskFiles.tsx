import { useEffect, useRef, useState } from 'react'
import { ChevronDown, GitBranch, Loader2, RefreshCw, ScanSearch } from 'lucide-react'
import { toast } from 'sonner'
import type { ContentFile, FileTree, SearchMode } from '@shared/files'
import { type Task, type TaskStep } from '@shared/schema'
import { mergeChanges, taskSummary } from '@shared/task'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { FileExplorer } from '@/components/files/FileTree'
import { DiffDialog } from './DiffDialog'
import { useFileOpen } from './FileDialog'

/**
 * 任务页右栏：任务工作目录（独立分支时是 worktree）的文件树，带 git 状态。
 * 「更改」也在这里：树上的状态标出改过哪些文件，上面的按钮列出改动、看差异、撤销或让 CLI 审查。
 */
export function TaskFiles({
  task,
  dir,
  node,
  onTask,
}: {
  task: Task
  /** 项目目录：分支还没读出来时先用它做说明 */
  dir?: string
  /** 流程图里选中的节点：只列这个节点改过的文件 */
  node?: TaskStep
  /** 压缩、审查之后把新的任务状态交回页面 */
  onTask?: (task: Task) => void
}) {
  const { upsertTask } = useData()
  const openFile = useFileOpen()
  const [tree, setTree] = useState<FileTree | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hits, setHits] = useState<ContentFile[]>([])
  const [hitsTruncated, setHitsTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // 改动过一次（新增、改了行数）才重新读：执行中每秒都在更新任务，不能跟着刷
  const changes = node
    ? (() => {
        const out: Task['changes'] = []
        mergeChanges(
          out,
          [node, ...task.steps.filter((s) => s.id.startsWith(node.id + '/'))].flatMap((s) => s.changes ?? []),
        )
        return out
      })()
    : task.changes
  const stamp = changes.map((c) => `${c.path}:${c.add}:${c.del}`).join('|')
  const idle = task.status !== 'running'

  const load = () => {
    setLoading(true)
    setError('')
    api
      .taskFiles(task.id)
      .then(setTree)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    // 任务换掉、改动过、执行结束后重新读一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, stamp, idle])

  // 按内容搜索：停顿一下再搜，输入过程中不发请求
  const search = (q: string, mode: SearchMode) => {
    const needle = q.trim()
    clearTimeout(timer.current)
    if (mode !== 'content' || !needle) {
      setHits([])
      setHitsTruncated(false)
      setSearching(false)
      return
    }
    setSearching(true)
    timer.current = setTimeout(() => {
      api
        .searchTaskFiles(task.id, needle)
        .then((r) => {
          setHits(r.files)
          setHitsTruncated(r.truncated)
        })
        .catch((e) => setError((e as Error).message))
        .finally(() => setSearching(false))
    }, 250)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  const add = changes.reduce((n, c) => n + c.add, 0)
  const del = changes.reduce((n, c) => n + c.del, 0)
  const shown = onlyChanged && tree ? { ...tree, files: tree.files.filter((f) => f.status) } : tree
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5">
        <span className="flex min-w-0 items-center gap-1 px-1 text-[0.75rem] text-subtle">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono" title={tree?.dir ?? dir}>
            {tree?.branch ?? t('没有分支')}
          </span>
        </span>
        <ChangesMenu
          changes={changes}
          add={add}
          del={del}
          only={onlyChanged}
          onOnly={setOnlyChanged}
          onDiff={setDiffPath}
          scoped={!!node}
          canReview={!node && idle && !task.simulated && !!tree?.isGit && changes.length > 0}
          reviewing={reviewing}
          onReview={async () => {
            setReviewing(true)
            try {
              onTask?.(await api.reviewTask(task.id))
            } catch (e) {
              toast.error((e as Error).message)
            } finally {
              setReviewing(false)
            }
          }}
        />
        <button
          type="button"
          aria-label={t('刷新文件')}
          title={t('刷新文件')}
          onClick={load}
          className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-sel hover:text-fg"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <FileExplorer
        tree={shown}
        error={error}
        hits={hits}
        hitsTruncated={hitsTruncated}
        searching={searching}
        loading={loading}
        onSearch={search}
        onOpen={(path, line) => openFile?.(path, line)}
        compact
      />
      <DiffDialog
        task={task}
        path={diffPath}
        onOpenChange={(o) => !o && setDiffPath(null)}
        onReverted={(x) => {
          upsertTask(taskSummary(x))
          // 撤销后文件状态变了，重新读一遍
          load()
        }}
      />
    </div>
  )
}

/** 「更改」：改动数量和增删行数，点开列出改过的文件 */
function ChangesMenu({
  changes,
  add,
  del,
  only,
  onOnly,
  onDiff,
  scoped,
  canReview,
  reviewing,
  onReview,
}: {
  changes: Task['changes']
  add: number
  del: number
  only: boolean
  onOnly: (v: boolean) => void
  onDiff: (path: string) => void
  /** 看的是流程图里选中的节点，不是整个任务 */
  scoped: boolean
  canReview: boolean
  reviewing: boolean
  onReview: () => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'ml-auto flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[0.6875rem] transition-colors hover:bg-sel data-[state=open]:bg-sel',
          changes.length ? 'text-muted' : 'text-subtle',
        )}
        title={t('改动过的文件')}
      >
        {changes.length ? (
          <>
            <span className="text-success">+{add}</span>
            {del > 0 && <span className="text-danger">-{del}</span>}
          </>
        ) : (
          t('没有改动')
        )}
        <ChevronDown className="h-3 w-3" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(420px,calc(100vw-24px))] p-0">
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <span className="px-1 text-[0.75rem] font-medium">{t('改动 {n} 个文件', { n: changes.length })}</span>
          <button
            type="button"
            role="switch"
            aria-checked={only}
            onClick={() => onOnly(!only)}
            className={cn(
              'ml-auto cursor-pointer rounded-md px-1.5 py-0.5 text-[0.6875rem] transition-colors',
              only ? 'bg-accent/12 text-accent' : 'text-subtle hover:bg-sel hover:text-fg',
            )}
          >
            {t('只看改动')}
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {changes.length ? (
            changes.map((c) => (
              <button
                key={c.path}
                type="button"
                onClick={() => onDiff(c.path)}
                title={t('查看「{path}」的改动', { path: c.path })}
                className={cn(menuItem, 'gap-2 py-1 font-mono text-xs')}
              >
                <span className="min-w-0 flex-1 truncate text-muted">{c.path}</span>
                <span className="shrink-0 text-success">+{c.add}</span>
                <span className="w-8 shrink-0 text-right text-danger">{c.del ? `-${c.del}` : ''}</span>
              </button>
            ))
          ) : (
            <p className="px-2.5 py-2 text-xs text-subtle">
              {scoped ? t('这个节点没有改动文件。') : t('还没有改动文件。')}
            </p>
          )}
        </div>
        {canReview && (
          <div className="border-t p-1">
            <button
              type="button"
              onClick={onReview}
              disabled={reviewing}
              title={t('让 CLI 审查还没提交的改动，只列问题，不改文件')}
              className={cn(menuItem, 'text-xs')}
            >
              {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
              {t('审查改动')}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
