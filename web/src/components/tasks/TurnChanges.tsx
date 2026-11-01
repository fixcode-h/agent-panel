import { useEffect, useState } from 'react'
import { List, ListTree, Loader2, TriangleAlert, Undo2 } from 'lucide-react'
import type { Task, TaskMessage, TurnChanges } from '@shared/schema'
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

/**
 * 一轮对话改了哪些文件：挂在这一轮的总结下面（数据见 server/turn-changes.ts）。
 * 只算这一轮自己的改动：子任务、工作流在这一轮里改的算，子对话合进来的、之前几轮的不算。
 * 点文件打开差异窗口（左边改动树、右边左右对照），「撤销」只撤这一轮的改动，之后又改过的地方保留，撤不干净时列出冲突、一个都不动
 */
export function TurnChangesCard({ task, msg }: { task: Pick<Task, 'id' | 'working'>; msg: TaskMessage }) {
  const ch = msg.turnChanges!
  const { upsertTask } = useData()
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [conflicts, setConflicts] = useState<{ path: string; reason: string }[]>([])
  const files = ch.files
  const shown = all ? files : files.slice(0, FIRST)
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)
  // 撤销成功后先在本地标上：对话页的完整任务靠推送刷新，不等它回来卡片就该显示「已撤销」
  const [done, setDone] = useState(false)
  const reverted = !!ch.revertedAt || done

  const revert = async () => {
    try {
      const r = await api.turnRevert(task.id, msg.id)
      setConfirm(false)
      if (!r.ok) {
        setConflicts(r.conflicts)
        return
      }
      setConflicts([])
      setDone(true)
      upsertTask(taskSummary(r.task))
      toast.success(t('已撤销这一轮的改动'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="turn-changes my-1 overflow-hidden rounded-xl border bg-card text-body">
      <div className="flex h-9 items-center gap-2 border-b px-3.5">
        <span className={cn('min-w-0 flex-1 truncate', reverted ? 'text-subtle' : 'text-fg')}>
          {t('已更改 {n} 个文件', { n: files.length })}
        </span>
        {reverted ? (
          <span className="shrink-0 text-xs text-subtle">{t('已撤销')}</span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={task.working}
            title={task.working ? t('对话正在执行，等这一轮结束后再撤销') : t('只撤销这一轮的改动')}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t('撤销')}
          </button>
        )}
      </div>
      <div className={cn('flex flex-col py-1', reverted && 'opacity-60')}>
        {shown.map((f) => {
          const Icon = fileIcon(f.path)
          return (
            <button
              key={f.path}
              type="button"
              onClick={() => setOpen(f.path)}
              title={f.path}
              className="flex h-7 w-full cursor-pointer items-center gap-2 px-3.5 text-left hover:bg-sel"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className={cn('min-w-0 flex-1 truncate', reverted && 'line-through')}>{baseName(f.path)}</span>
              <span className="shrink-0 font-mono text-xs text-success">+{f.add}</span>
              <span className="shrink-0 font-mono text-xs text-danger">-{f.del}</span>
            </button>
          )
        })}
      </div>
      {files.length > FIRST && (
        <div className="flex h-8 items-center gap-2 border-t px-3.5">
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-muted hover:text-fg"
          >
            {all ? t('收起') : t('查看全部')}
          </button>
          <span className="shrink-0 font-mono text-xs text-success">+{add.toLocaleString()}</span>
          <span className="shrink-0 font-mono text-xs text-danger">-{del.toLocaleString()}</span>
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
          <span className="pl-5 text-muted">{t('这些地方在这一轮之后又被改过，请在编辑器里手动处理。')}</span>
        </div>
      )}
      <TurnDiffDialog taskId={task.id} msgId={msg.id} changes={ch} path={open} onPath={setOpen} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('撤销这一轮的改动？')}
        description={t(
          '{n} 个文件会恢复成这一轮开始前的样子，这一轮新建的文件会被删除；这一轮之后你或其他对话在这些文件里的改动会保留。改到同一处时不会撤销，会列出冲突。',
          { n: files.length },
        )}
        confirmText={t('撤销')}
        onConfirm={revert}
      />
    </div>
  )
}

/**
 * 一轮改动的差异窗口：左边是这一轮改的文件（默认按目录树，可以切成列表），右边是选中文件的差异（默认左右对照）。
 * 窄屏放不下左栏，只留顶部的上一个 / 下一个
 */
function TurnDiffDialog({
  taskId,
  msgId,
  changes,
  path,
  onPath,
}: {
  taskId: string
  msgId: string
  changes: TurnChanges
  path: string | null
  onPath: (path: string | null) => void
}) {
  const [data, setData] = useState<{ path: string; diff: string } | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<'tree' | 'list'>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!path) return
    let live = true
    setError('')
    api
      .turnDiff(taskId, msgId, path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError((e as Error).message))
    return () => {
      live = false
    }
  }, [taskId, msgId, path])
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
    <Modal open={!!path} onOpenChange={(o) => !o && onPath(null)} title={null} size="xl" bare closeOnOutside>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-card md:flex" aria-label={t('这一轮的改动')}>
          {/* 和右边差异的标题栏（ModalHeader）同高，横线连成一条 */}
          <div className="flex h-[2.0625rem] shrink-0 items-center gap-2 border-b border-(color:--modal-edge) px-3">
            <span className="min-w-0 flex-1 truncate text-body font-medium">
              {t('已更改 {n} 个文件', { n: changes.files.length })}
            </span>
            <Segmented
              size="sm"
              iconOnly
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
        <div className="flex min-w-0 flex-1 flex-col">
          <DiffShell
            path={path ?? ''}
            diff={ready ? data.diff : ''}
            stats={stat ? { add: stat.add, del: stat.del } : undefined}
            files={changes.files.map((f) => f.path)}
            onNavigate={onPath}
            close={<ModalClose />}
            empty={
              error ? (
                <p className="p-6 text-body text-danger">{error}</p>
              ) : !ready ? (
                <div className="flex h-full min-h-32 items-center justify-center gap-2 text-body text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('正在读取差异…')}
                </div>
              ) : (
                <p className="p-6 text-body text-subtle">{t('这一轮里这个文件没有文字差异（可能是二进制文件）。')}</p>
              )
            }
          />
        </div>
      </div>
    </Modal>
  )
}
