import { useEffect, useState } from 'react'
import { GitBranch, List, ListTree, Loader2, RefreshCw, ScanSearch } from 'lucide-react'
import { toast } from '@/lib/toast'
import { type Task, type TaskStep } from '@shared/schema'
import { mergeChanges, taskSummary } from '@shared/task'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { menuItem } from '@/components/ui/menu'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { IconButton } from '@/components/ui/icon-button'
import { FileExplorer } from '@/components/files/FileTree'
import { ProjectFileDialog } from '@/components/files/ProjectFileDialog'
import { useProjectFiles } from '@/components/files/ProjectFileExplorer'
import { ChangesTree } from './ChangesTree'
import { DiffDialog } from './DiffDialog'
import { FileDialog } from './FileDialog'

/**
 * 执行中文件改动合并的时间窗。一次工具调用可能连着改好几个文件，
 * 每个都触发一次文件树重读既没意义又费请求；合并成一波可以接受几百毫秒的延迟。
 */
const REFRESH_DELAY = 350

/**
 * 刷新键去抖：执行中隔一小段时间合并一次，任务状态一变（跑完、出错）立即生效。
 * 返回的值交给 useProjectFiles 当 refreshKey 用。
 */
function useRefreshKey(raw: string, immediate: boolean) {
  const [key, setKey] = useState(raw)
  useEffect(() => {
    // 任务状态变了就立即跟上，顺带补上还在等待窗口里没落地的那次改动
    if (immediate) {
      setKey(raw)
      return
    }
    if (key === raw) return
    const timer = setTimeout(() => setKey(raw), REFRESH_DELAY)
    return () => clearTimeout(timer)
  }, [raw, immediate, key])
  return key
}

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
  // 执行中文件一直在改，把接连的改动合并成一次重读；任务结束/出错时立刻重读，保证最终状态及时
  const ended = task.status !== 'running'
  const refreshKey = useRefreshKey(`${task.id}|${stamp}|${ended}`, ended)
  const files = useProjectFiles(task.projectId, refreshKey, task.id)
  const add = changes.reduce((n, c) => n + c.add, 0)
  const del = changes.reduce((n, c) => n + c.del, 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 右栏固定两个页签（照 Proma 的页签条）：项目文件 / 本对话改动；分支和刷新放在右端 */}
      <TabBar
        label={t('文件视图')}
        trailing={
          <>
            <span
              className="flex max-w-28 min-w-0 items-center gap-1 text-[0.75rem] text-subtle"
              title={files.info?.dir ?? dir}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate font-mono">{files.info?.branch ?? t('没有分支')}</span>
            </span>
            <IconButton label={t('刷新文件')} onClick={files.refresh}>
              <RefreshCw className={cn('h-3.5 w-3.5', files.loading && 'animate-spin')} />
            </IconButton>
          </>
        }
      >
        <TabItem fill active={tab === 'files'} onSelect={() => setTab('files')}>
          {t('项目文件')}
        </TabItem>
        <TabItem
          fill
          active={tab === 'changes'}
          onSelect={() => setTab('changes')}
          tag={changes.length > 0 ? changes.length : undefined}
          title={changes.length > 0 ? `+${add} -${del}` : undefined}
        >
          {t('本对话改动')}
        </TabItem>
      </TabBar>
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
        files={changes.map((c) => c.path)}
        onPathChange={setDiffPath}
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
  const [mode, setMode] = useState<'tree' | 'list'>('tree')
  // 默认全展开，所以这里存的是收起的目录
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  const add = changes.reduce((n, c) => n + c.add, 0)
  const del = changes.reduce((n, c) => n + c.del, 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
        <span className="min-w-0 truncate text-[0.75rem] font-medium">
          {t('改动 {n} 个文件', { n: changes.length })}
        </span>
        {changes.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div role="radiogroup" aria-label={t('改动显示方式')} className="flex rounded-md bg-field p-0.5">
              {(
                [
                  ['tree', t('树形'), ListTree],
                  ['list', t('列表'), List],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={mode === id}
                  title={id === 'tree' ? t('按目录分组显示') : t('平铺显示每个文件')}
                  onClick={() => setMode(id)}
                  className={cn(
                    'flex h-5 cursor-pointer items-center gap-1 rounded px-1.5 text-[0.6875rem] transition-colors',
                    mode === id ? 'bg-card font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
                  )}
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
            <span className="font-mono text-[0.6875rem]">
              <span className="text-success">+{add}</span>
              {del > 0 && <span className="text-danger"> -{del}</span>}
            </span>
          </div>
        )}
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto', mode === 'tree' ? 'py-1' : 'p-1')}>
        {mode === 'tree' ? (
          <ChangesTree changes={changes} onDiff={onDiff} scoped={scoped} collapsed={collapsed} onToggle={toggleDir} />
        ) : changes.length ? (
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
            title={t('让 Agent 审查还没提交的改动，只列问题，不改文件')}
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
