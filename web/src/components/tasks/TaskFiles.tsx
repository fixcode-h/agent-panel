import { useEffect, useState, type ReactNode } from 'react'
import {
  Diff,
  FileText,
  GitBranch,
  List,
  ListTree,
  Loader2,
  MessageSquareText,
  RefreshCw,
  ScanSearch,
  Search,
} from 'lucide-react'
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
import { type FileBrowser, FileExplorer } from '@/components/files/FileTree'
import { ProjectFileDialog } from '@/components/files/ProjectFileDialog'
import { useProjectFiles } from '@/components/files/ProjectFileExplorer'
import { childIcon } from '@shared/task'
import type { ChildSummary } from './child-line'
import { ChangesTree } from './ChangesTree'
import { TaskStatusIcon } from './TaskStatusIcon'
import { DiffDialog } from './DiffDialog'
import { FileDialog } from './FileDialog'

/**
 * 执行中文件改动合并的时间窗。一次工具调用可能连着改好几个文件，
 * 每个都触发一次文件树重读既没意义又费请求；合并成一波可以接受几百毫秒的延迟。
 */
const REFRESH_DELAY = 350

/** 改动标记最多读这么多个目录的 git 状态；改动散在更多目录时剩下的按「改动」标 */
const MARK_DIRS = 30

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

type Mark = 'A' | 'M' | 'D'
const MARK_TONE: Record<Mark, string> = { A: 'text-success', M: 'text-warning', D: 'text-danger' }

/**
 * 改动文件的 A/M/D：任务只记了增删行数，新增、删除要看 git。
 * 所在目录读到了：不在列表里就是删了，状态是新增 / 未跟踪就是新增；没读到先按「改动」标
 */
function changeMark(files: FileBrowser, path: string): Mark {
  const level = files.levels[parentOf(path)]
  if (!level) return 'M'
  const entry = level.entries.find((e) => e.path === path)
  if (!entry) return 'D'
  return entry.status === 'A' || entry.status === '?' ? 'A' : entry.status === 'D' ? 'D' : 'M'
}

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
 * 打开子对话时多一个子对话页签，子对话就在这一栏里看和回复，不占中间的对话。
 */
export function TaskFiles({
  task,
  dir,
  node,
  onTask,
  child,
}: {
  task: Task
  /** 项目目录：分支还没读出来时先用它做说明 */
  dir?: string
  /** 流程图里选中的节点：只列这个节点改过的文件 */
  node?: TaskStep
  /** 压缩、审查之后把新的任务状态交回页面 */
  onTask?: (task: Task) => void
  /** 右栏开着的子对话：多一个可关的页签，内容是子对话自己的面板 */
  child?: { id: string; task?: ChildSummary; view: ReactNode; onClose: () => void }
}) {
  const { upsertTask } = useData()
  const [tab, setTab] = useState<'files' | 'changes' | 'child'>(child ? 'child' : 'files')
  // 新开（或换了）子对话就切到它的页签；关掉后回项目文件
  const childId = child?.id ?? ''
  useEffect(() => {
    setTab((cur) => (childId ? 'child' : cur === 'child' ? 'files' : cur))
  }, [childId])
  const onChild = tab === 'child' && !!child
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [target, setTarget] = useState<{ path: string; line?: number } | null>(null)
  /** 右栏只放文件树：查找收进信息行的图标按钮，点开才出搜索栏 */
  const [searchOpen, setSearchOpen] = useState(false)
  /** 改动的显示方式：默认按设计稿平铺（标记 + 路径 + 增删行数），也能切回按目录分组 */
  const [mode, setMode] = useState<'tree' | 'list'>('list')
  /** 最近点开看差异的文件：差异窗口关掉后列表里还标着，知道刚看到哪 */
  const [picked, setPicked] = useState<string | null>(null)

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
  // 改动标记（A/M/D）要看 git 状态：切到「本对话改动」时把改动文件所在的那几层读出来（读过的不重复请求）
  const dirs = [...new Set(changes.map((c) => parentOf(c.path)))].slice(0, MARK_DIRS).join('\n')
  useEffect(() => {
    if (tab !== 'changes' || !dirs) return
    for (const d of dirs.split('\n')) void files.load(d)
    // 只在切页签、改动目录或刷新时读；files 每次渲染都是新对象
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dirs, files.version])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 右栏固定两个页签：项目文件 / 本对话改动，按内容宽度左对齐（设计稿 .ptab.sm） */}
      <TabBar label={t('文件视图')} variant="fit">
        <TabItem
          active={tab === 'files'}
          onSelect={() => setTab('files')}
          icon={<FileText className="h-[0.8125rem] w-[0.8125rem]" />}
        >
          {t('项目文件')}
        </TabItem>
        <TabItem
          active={tab === 'changes'}
          onSelect={() => setTab('changes')}
          icon={<Diff className="h-[0.8125rem] w-[0.8125rem]" />}
          tag={changes.length > 0 ? changes.length : undefined}
          title={changes.length > 0 ? `+${add} -${del}` : undefined}
        >
          {t('本对话改动')}
        </TabItem>
        {child && (
          <TabItem
            active={onChild}
            onSelect={() => setTab('child')}
            onClose={child.onClose}
            closeLabel={t('关闭子对话')}
            title={[t('子对话'), child.task?.title].filter(Boolean).join(' · ')}
            icon={
              child.task ? (
                <TaskStatusIcon status={child.task.status} icon={childIcon(child.task)} className="h-3.5 w-3.5" />
              ) : (
                <MessageSquareText className="h-[0.8125rem] w-[0.8125rem]" />
              )
            }
            className="max-w-[12rem] min-w-0"
          >
            {child.task?.title ?? t('子对话')}
          </TabItem>
        )}
      </TabBar>
      {/* 子对话页签：切到文件、改动时只是藏起来，不卸载 */}
      {child && (
        <section
          aria-label={t('子对话')}
          data-child-view
          className={cn('flex min-h-0 flex-1 flex-col', !onChild && 'hidden')}
        >
          {child.view}
        </section>
      )}
      {!onChild && (
        <>
          {/* 项目信息行：分支 · 改动数；行尾是这一页的工具（查找、显示方式）和刷新 */}
          <div className="flex h-[1.875rem] shrink-0 items-center gap-1.5 border-b pr-2.5 pl-4 text-[0.75rem] text-subtle">
            <GitBranch className="h-[0.8125rem] w-[0.8125rem] shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 truncate font-mono text-[0.71875rem] text-muted" title={files.info?.dir ?? dir}>
              {files.info?.branch ?? t('没有分支')}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{t('{n} 个改动', { n: changes.length })}</span>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {tab === 'files' ? (
                <IconButton
                  icon={Search}
                  label={t('查找文件')}
                  size="2xs"
                  aria-pressed={searchOpen}
                  onClick={() => setSearchOpen((v) => !v)}
                  className={cn(searchOpen && 'bg-sel text-fg')}
                />
              ) : (
                changes.length > 0 && (
                  <IconButton
                    icon={mode === 'tree' ? List : ListTree}
                    label={mode === 'tree' ? t('平铺显示每个文件') : t('按目录分组显示')}
                    size="2xs"
                    onClick={() => setMode(mode === 'tree' ? 'list' : 'tree')}
                  />
                )
              )}
              <IconButton label={t('刷新文件')} size="2xs" onClick={files.refresh}>
                <RefreshCw className={cn('h-3 w-3', files.loading && 'animate-spin')} />
              </IconButton>
            </div>
          </div>
          {tab === 'files' ? (
            <>
              <FileExplorer
                browser={files}
                onOpen={(path, line) => setTarget({ path, line })}
                compact
                searchOpen={searchOpen}
                onSearchOpenChange={setSearchOpen}
              />
              {/* 文件在中间的查看窗口里打开，右栏只放树；提示一行，免得以为点了没反应 */}
              <p className="shrink-0 px-4 pt-2.5 pb-3 text-center text-[0.71875rem] text-subtle/80">
                {t('点文件在中间查看')}
              </p>
            </>
          ) : (
            <ChangesList
              changes={changes}
              mode={mode}
              mark={(path) => changeMark(files, path)}
              picked={picked}
              onDiff={(path) => {
                setPicked(path)
                setDiffPath(path)
              }}
              scoped={!!node}
              canReview={
                !node && task.status !== 'running' && !task.simulated && !!files.info?.isGit && changes.length > 0
              }
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
        </>
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
 * 「改动」Tab 的内容：只列改过的文件（标记 + 路径 + 增删行数），点开在中间的差异窗口里看；
 * 底部可以让 CLI 审查还没提交的改动
 */
function ChangesList({
  changes,
  mode,
  mark,
  picked,
  onDiff,
  scoped,
  canReview,
  reviewing,
  onReview,
}: {
  changes: Task['changes']
  mode: 'tree' | 'list'
  mark: (path: string) => Mark
  /** 最近点开的文件，行上标底色 */
  picked: string | null
  onDiff: (path: string) => void
  /** 看的是流程图里选中的节点，不是整个任务 */
  scoped: boolean
  canReview: boolean
  reviewing: boolean
  onReview: () => void
}) {
  // 默认全展开，所以这里存的是收起的目录
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {mode === 'tree' ? (
          <ChangesTree changes={changes} onDiff={onDiff} scoped={scoped} collapsed={collapsed} onToggle={toggleDir} />
        ) : changes.length ? (
          <div className="flex flex-col gap-0.5">
            {changes.map((c) => {
              const m = mark(c.path)
              return (
                <button
                  key={c.path}
                  type="button"
                  onClick={() => onDiff(c.path)}
                  title={t('查看「{path}」的改动', { path: c.path })}
                  className={cn(
                    'flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-sel/60',
                    picked === c.path && 'bg-sel hover:bg-sel',
                  )}
                >
                  <span
                    className={cn(
                      'grid h-[1.125rem] w-[1.125rem] shrink-0 place-items-center rounded-[5px] bg-field font-mono text-[0.6875rem] font-bold',
                      MARK_TONE[m],
                    )}
                  >
                    {m}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]">{c.path}</span>
                  {c.add > 0 && <span className="shrink-0 font-mono text-[0.6875rem] text-success">+{c.add}</span>}
                  {c.del > 0 && <span className="shrink-0 font-mono text-[0.6875rem] text-danger">−{c.del}</span>}
                </button>
              )
            })}
          </div>
        ) : (
          <p className="mx-2 my-3 rounded-xl border border-dashed border-line-strong p-6 text-center text-[0.8125rem] text-subtle">
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
