import { useEffect, useState } from 'react'
import { FileDiff, List, ListTree, Loader2, TriangleAlert, Undo2 } from 'lucide-react'
import type { FileChange, Task } from '@shared/schema'
import { convChanges } from '@shared/conv-changes'
import { taskSummary } from '@shared/task'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { fileIcon } from '@/lib/file-icon'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Modal, ModalClose } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { ChangesTree } from './ChangesTree'
import { DiffShell } from './DiffDialog'

/** 卡片上先列几个文件，其余的点「查看全部」展开 */
const FIRST = 3

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/**
 * 整个对话改了哪些文件（数据见 shared/conv-changes.ts，每一轮的记录见 server/turn-changes.ts）：
 * 只在对话停下来以后、挂在对话最后面一张（以前每一轮总结下面各挂一张，用户要只看整个对话的）。
 * 只算这个对话自己的改动：子任务、工作流在对话里改的算，子对话合进来的、用户在两轮之间自己改的不算。
 * 点文件打开差异窗口（左边改动树、右边左右对照），「撤销」把每一轮的改动从后往前一起撤，之后又改过的地方保留，
 * 撤不干净时列出冲突、一个都不动
 */
export function ConvChangesCard({ task }: { task: Pick<Task, 'id' | 'working' | 'messages'> }) {
  const ch = convChanges(task.messages)
  const { upsertTask } = useData()
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [conflicts, setConflicts] = useState<{ path: string; reason: string }[]>([])
  // 撤销成功后先在本地标上：对话页的完整任务靠推送刷新，不等它回来卡片就该显示「已撤销」
  const [done, setDone] = useState(false)
  const files = ch.files
  // 全部撤销过（或刚撤完）：卡片变灰、写「已撤销」，文件还列着方便回看是哪些
  const reverted = done || (!files.length && ch.reverted > 0)
  if (!files.length && !reverted) return null
  const shown = all ? files : files.slice(0, FIRST)
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)

  const revert = async () => {
    try {
      const r = await api.convRevert(task.id)
      setConfirm(false)
      if (!r.ok) {
        setConflicts(r.conflicts)
        return
      }
      setConflicts([])
      setDone(true)
      upsertTask(taskSummary(r.task))
      toast.success(t('已撤销这个对话的改动'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="turn-changes my-1 overflow-hidden rounded-xl border bg-card text-body">
      <div className="flex h-9 items-center gap-2 border-b px-3.5">
        <span className={cn('min-w-0 truncate font-medium', reverted ? 'text-subtle' : 'text-fg')}>
          {reverted ? t('这个对话的改动已撤销') : t('这个对话改了 {n} 个文件', { n: files.length })}
        </span>
        {!reverted && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
            <span className="text-success">+{add.toLocaleString()}</span>
            <span className="text-danger">-{del.toLocaleString()}</span>
          </span>
        )}
        <span className="flex-1" />
        {!reverted && (
          <button
            type="button"
            onClick={() => setOpen(files[0].path)}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-sel hover:text-fg"
          >
            <FileDiff className="h-3.5 w-3.5" />
            {t('查看改动')}
          </button>
        )}
        {!reverted && (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={task.working}
            title={task.working ? t('对话正在执行，等这一轮结束后再撤销') : t('撤销这个对话改的所有文件')}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t('撤销')}
          </button>
        )}
      </div>
      {!reverted && (
        <div className="flex flex-col py-1">
          {shown.map((f) => {
            const Icon = fileIcon(f.path)
            const dir = dirName(f.path)
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => setOpen(f.path)}
                title={f.path}
                className="flex h-7 w-full cursor-pointer items-center gap-2 px-3.5 text-left hover:bg-sel"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="shrink-0 truncate">{baseName(f.path)}</span>
                {/* 目录跟在文件名后面、灰一点：同名文件（index.ts）分得开，又不抢文件名 */}
                <span className="min-w-0 flex-1 truncate text-xs text-subtle">{dir}</span>
                <span className="shrink-0 font-mono text-xs text-success">+{f.add}</span>
                <span className="w-9 shrink-0 text-right font-mono text-xs text-danger">
                  {f.del ? `-${f.del}` : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {!reverted && files.length > FIRST && (
        <div className="flex h-8 items-center border-t px-3.5">
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="min-w-0 cursor-pointer truncate text-left text-muted hover:text-fg"
          >
            {all ? t('收起') : t('查看全部 {n} 个文件', { n: files.length })}
          </button>
        </div>
      )}
      {/* 同目录别的对话那段时间改的文件已经剔除（server/turn-owners.ts）：说一句，免得用户以为少记了，悬停能看到是哪些 */}
      {!reverted && ch.others.length > 0 && (
        <div className="turn-changes-others border-t px-3.5 py-1.5 text-xs text-subtle" title={ch.others.join('\n')}>
          {t('另有 {n} 个文件是同目录里别的对话改的，没有算进来，撤销时也不会动', { n: ch.others.length })}
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="flex flex-col gap-1 border-t bg-warning/10 px-3.5 py-2 text-xs leading-relaxed text-warning">
          <span className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {t('有 {n} 个文件撤不干净，所有文件都没动：', { n: conflicts.length })}
          </span>
          {conflicts.map((c) => (
            <span key={c.path} className="truncate pl-5" title={c.path}>
              <span className="font-mono">{c.path}</span> · {c.reason}
            </span>
          ))}
          <span className="pl-5 text-muted">{t('这些地方在这个对话改完之后又被改过，请在编辑器里手动处理。')}</span>
        </div>
      )}
      <TurnDiffDialog load={(p) => api.convDiff(task.id, p)} files={files} path={open} onPath={setOpen} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('撤销这个对话的改动？')}
        description={t(
          '{n} 个文件会恢复成这个对话改之前的样子，对话里新建的文件会被删除；你或其他对话之后在这些文件里的改动会保留。改到同一处时不会撤销，会列出冲突。',
          { n: files.length },
        )}
        confirmText={t('撤销')}
        onConfirm={revert}
      />
    </div>
  )
}

/**
 * 改动的差异窗口：左边是改了的文件（默认按目录树，可以切成列表），右边是选中文件的差异（默认左右对照）。
 * 大屏可以收起左栏把宽度全给差异；窄屏（lg 以下）放不下左栏，只留顶部的上一个 / 下一个
 */
function TurnDiffDialog({
  load,
  files,
  path,
  onPath,
}: {
  /** 取一个文件的差异：整个对话的改动按各轮先后拼起来（见 server/tasks/files-routes.ts 的 conv-diff） */
  load: (path: string) => Promise<{ path: string; diff: string }>
  files: FileChange[]
  path: string | null
  onPath: (path: string | null) => void
}) {
  const changes = { files }
  const [data, setData] = useState<{ path: string; diff: string } | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<'tree' | 'list'>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // 左栏可以收起：文件多、路径长时把整块宽度让给左右对照
  const [treeOpen, setTreeOpen] = useState(true)
  useEffect(() => {
    if (!path) return
    let live = true
    setError('')
    load(path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError((e as Error).message))
    return () => {
      live = false
    }
    // load 每次渲染都是新函数：只按文件换着取，放进依赖会每次渲染都重取一遍
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  const ready = !!data && data.path === path
  const stat = changes.files.find((f) => f.path === path)
  const toggle = (p: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  return (
    <Modal open={!!path} onOpenChange={(o) => !o && onPath(null)} title={null} size="diff" bare closeOnOutside>
      <div className="flex min-h-0 flex-1">
        {treeOpen && (
          <aside className="hidden w-64 shrink-0 flex-col border-r bg-card lg:flex" aria-label={t('这个对话的改动')}>
            {/* 和右边差异的标题栏（ModalHeader）同高，横线连成一条 */}
            <div className="flex h-[2.0625rem] shrink-0 items-center gap-2 border-b border-(color:--modal-edge) px-3">
              <span className="min-w-0 flex-1 truncate text-body font-medium">
                {t('已更改 {n} 个文件', { n: changes.files.length })}
              </span>
              <Segmented
                size="sm"
                iconOnly
                // 和右边差异的标题栏同高（33px）：段控件压到 24px（每段 20px），上下留出边距；照 ProjectFileDialog 标题栏的写法
                className="shrink-0 flex-nowrap *:h-5 *:w-5"
                label={t('改动显示方式')}
                value={view}
                onChange={setView}
                options={[
                  { id: 'tree', label: t('按目录'), icon: ListTree },
                  { id: 'list', label: t('列表'), icon: List },
                ]}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {view === 'tree' ? (
                <ChangesTree
                  changes={changes.files}
                  onDiff={onPath}
                  scoped={false}
                  collapsed={collapsed}
                  onToggle={toggle}
                  selected={path ?? undefined}
                />
              ) : (
                changes.files.map((f) => {
                  const Icon = fileIcon(f.path)
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => onPath(f.path)}
                      title={f.path}
                      aria-current={f.path === path ? 'true' : undefined}
                      className={cn(
                        'flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 text-left font-mono text-xs hover:bg-sel',
                        f.path === path && 'bg-sel',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                      <span className="min-w-0 flex-1 truncate text-muted">{f.path}</span>
                      <span className="shrink-0 text-success">+{f.add}</span>
                      <span className="w-8 shrink-0 text-right text-danger">{f.del ? `-${f.del}` : ''}</span>
                    </button>
                  )
                })
              )}
            </div>
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <DiffShell
            path={path ?? ''}
            diff={ready ? data.diff : ''}
            stats={stat ? { add: stat.add, del: stat.del } : undefined}
            files={changes.files.map((f) => f.path)}
            onNavigate={onPath}
            close={<ModalClose />}
            sidebar={{ open: treeOpen, onToggle: () => setTreeOpen((v) => !v) }}
            empty={
              error ? (
                <p className="p-6 text-body text-danger">{error}</p>
              ) : !ready ? (
                <div className="flex h-full min-h-32 items-center justify-center gap-2 text-body text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('正在读取差异…')}
                </div>
              ) : (
                <p className="p-6 text-body text-subtle">{t('这个文件没有文字差异（可能是二进制文件）。')}</p>
              )
            }
          />
        </div>
      </div>
    </Modal>
  )
}
