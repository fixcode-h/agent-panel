import { useState } from 'react'
import { Files, GitBranch, GitCompareArrows, Loader2, RefreshCw, ScanSearch } from 'lucide-react'
import { toast } from 'sonner'
import { type Task, type TaskStep } from '@shared/schema'
import { mergeChanges, taskSummary } from '@shared/task'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { menuItem } from '@/components/ui/menu'
import { FileExplorer } from '@/components/files/FileTree'
import { ProjectFileDialog } from '@/components/files/ProjectFileDialog'
import { useProjectFiles } from '@/components/files/ProjectFileExplorer'
import { DiffDialog } from './DiffDialog'
import { FileDialog } from './FileDialog'

/**
 * 任务页右栏：当前项目的文件树，带 git 状态；没有项目的聊天用任务工作目录。
 * 上方一排 Tab 分「文件」和「改动」：改动页列出改过哪些文件、看差异、撤销或让 CLI 审查。
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
  const [tab, setTab] = useState<'files' | 'changes'>('files')
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [target, setTarget] = useState<{ path: string; line?: number } | null>(null)

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
  const files = useProjectFiles(task.projectId, `${task.id}|${stamp}|${task.status !== 'running'}`, task.id)
  const add = changes.reduce((n, c) => n + c.add, 0)
  const del = changes.reduce((n, c) => n + c.del, 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1.5" role="tablist" aria-label={t('文件视图')}>
        {(
          [
            ['files', t('文件'), Files],
            ['changes', t('改动'), GitCompareArrows],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[0.75rem] transition-colors',
              tab === id ? 'bg-sel font-medium text-fg' : 'text-muted hover:text-fg',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {label}
            {id === 'changes' && changes.length > 0 && (
              <span className="font-mono text-[0.6875rem]">
                <span className="text-success">+{add}</span>
                {del > 0 && <span className="text-danger"> -{del}</span>}
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto flex min-w-0 items-center gap-1 px-1 text-[0.75rem] text-subtle">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono" title={files.info?.dir ?? dir}>
            {files.info?.branch ?? t('没有分支')}
          </span>
        </span>
        <button
          type="button"
          aria-label={t('刷新文件')}
          title={t('刷新文件')}
          onClick={files.refresh}
          className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-sel hover:text-fg"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', files.loading && 'animate-spin')} />
        </button>
      </div>
      {tab === 'files' ? (
        <FileExplorer browser={files} onOpen={(path, line) => setTarget({ path, line })} compact />
      ) : (
        <ChangesList
          changes={changes}
          onDiff={setDiffPath}
          scoped={!!node}
          canReview={!node && task.status !== 'running' && !task.simulated && !!files.info?.isGit && changes.length > 0}
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
      )}
      {task.projectId ? (
        <ProjectFileDialog
          projectId={task.projectId}
          dir={files.info?.dir ?? dir ?? ''}
          target={target}
          onOpenChange={(open) => !open && setTarget(null)}
        />
      ) : (
        <FileDialog taskId={task.id} target={target} onOpenChange={(open) => !open && setTarget(null)} />
      )}
      <DiffDialog
        task={task}
        path={diffPath}
        onOpenChange={(o) => !o && setDiffPath(null)}
        onReverted={(x) => {
          upsertTask(taskSummary(x))
          // 撤销后文件状态变了，重新读一遍
          files.refresh()
        }}
      />
    </div>
  )
}

/**
 * 「改动」Tab 的内容：改过的文件一列，点开看差异；底部可以让 CLI 审查还没提交的改动。
 * 上半部分是列表，列表只有改动文件时才需要滚动
 */
function ChangesList({
  changes,
  onDiff,
  scoped,
  canReview,
  reviewing,
  onReview,
}: {
  changes: Task['changes']
  onDiff: (path: string) => void
  /** 看的是流程图里选中的节点，不是整个任务 */
  scoped: boolean
  canReview: boolean
  reviewing: boolean
  onReview: () => void
}) {
  const add = changes.reduce((n, c) => n + c.add, 0)
  const del = changes.reduce((n, c) => n + c.del, 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
        <span className="text-[0.75rem] font-medium">{t('改动 {n} 个文件', { n: changes.length })}</span>
        {changes.length > 0 && (
          <span className="ml-auto font-mono text-[0.6875rem]">
            <span className="text-success">+{add}</span>
            {del > 0 && <span className="text-danger"> -{del}</span>}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
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
          <p className="p-4 text-[0.8125rem] text-subtle">
            {scoped ? t('这个节点没有改动文件。') : t('还没有改动文件。')}
          </p>
        )}
      </div>
      {canReview && (
        <div className="shrink-0 border-t p-1">
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
    </div>
  )
}
