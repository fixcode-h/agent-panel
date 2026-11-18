import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { List, ListTree, Loader2, TriangleAlert } from 'lucide-react'
import type { FileChange, Task, TaskMessage } from '@shared/schema'
import { convChanges, scopeChanges, type ChangeScope, type ConvChanges } from '@shared/conv-changes'
import { compValue } from '@shared/component-style'
import { taskSummary } from '@shared/task'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { componentsSnapshot, subscribeComponents } from '@/lib/appearance'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { fileIcon } from '@/lib/file-icon'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Modal, ModalClose } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { ChangesCard, ChangesCardNote } from '@/components/ui/changes-card'
import { ChangesTree } from './ChangesTree'
import { DiffShell } from './DiffDialog'

/**
 * 改动卡片（外形见 web/src/components/ui/changes-card.tsx，数据见 shared/conv-changes.ts，每一轮的记录见 server/turn/changes.ts）：
 * 只在对话停下来以后、挂在对话最后面一张。默认看「这一轮」（用户最后一次发话以后到它停下，和本轮产出同一个口径），
 * 标题左边切到「整个对话」；默认看哪一段、先列几个在设置 → 组件 →「改动卡片」里改（设计稿 Bug模式子对话体验 第 3 节）。
 * 以前只有整个对话一张（更早是每一轮总结下面各挂一张）；用户 2026-11-18 要看这一段改了什么，整个对话收成切换。
 * 只算这个对话自己的改动：子任务、工作流在对话里改的算，子对话合进来的、用户在两轮之间自己改的不算。
 * 点文件打开差异窗口（左边改动树、右边左右对照）；「撤销」跟着切换走：这一轮时只撤这一轮，整个对话时各轮从后往前一起撤，
 * 之后又改过的地方保留，撤不干净时列出冲突、一个都不动。
 * tag：按路径给文件行加标签（Bug 模式里补排查动过的文件），由调用方给
 */
export function ConvChangesCard({
  task,
  tag,
}: {
  task: Pick<Task, 'id' | 'working' | 'messages'>
  tag?: (path: string) => ReactNode
}) {
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  const conv = convChanges(task.messages)
  const round = scopeChanges(task.messages, 'round')
  // 只有一轮改过文件时两段一样，不画切换
  const same = round.turns.join() === conv.turns.join()
  const want = (compValue(style, 'changesCard', 'scope') as ChangeScope) === 'conv' ? 'conv' : 'round'
  const [picked, setPicked] = useState<ChangeScope | null>(null)
  // 默认那一段没改文件（这一轮只聊了几句）时先显示另一段，用户点过就照点的
  const scope: ChangeScope = same
    ? 'conv'
    : (picked ?? (want === 'round' && !round.files.length && conv.files.length ? 'conv' : want))
  const ch = scope === 'round' ? round : conv
  const first = Number(compValue(style, 'changesCard', 'first')) || 3
  const added = useAddedFiles(task.id, ch)
  const { upsertTask } = useData()
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [conflicts, setConflicts] = useState<{ path: string; reason: string }[]>([])
  // 撤销成功后先在本地标上（按撤的是哪一段记）：对话页的完整任务靠推送刷新，不等它回来卡片就该显示「已撤销」
  const [done, setDone] = useState<ChangeScope | null>(null)
  const files = ch.files
  // 全部撤销过（或刚撤完）：卡片变灰、写「已撤销」，文件还列着方便回看是哪些
  const reverted = done === scope || done === 'conv' || (!files.length && ch.reverted > 0)
  if (!conv.files.length && !conv.reverted && !done) return null
  const isRound = scope === 'round' && !same

  const revert = async () => {
    try {
      const r = await api.convRevert(task.id, isRound ? 'round' : 'conv')
      setConfirm(false)
      if (!r.ok) {
        setConflicts(r.conflicts)
        return
      }
      setConflicts([])
      setDone(isRound ? 'round' : 'conv')
      upsertTask(taskSummary(r.task))
      toast.success(isRound ? t('已撤销这一轮的改动') : t('已撤销这个对话的改动'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const title = reverted
    ? isRound
      ? t('这一轮的改动已撤销')
      : t('这个对话的改动已撤销')
    : !files.length
      ? t('这一轮没有改文件')
      : isRound
        ? t('这一轮改了 {n} 个文件', { n: files.length })
        : t('这个对话改了 {n} 个文件', { n: files.length })
  const since = isRound ? roundStart(task.messages) : null
  return (
    <ChangesCard
      title={title}
      scope={
        same
          ? undefined
          : {
              value: scope,
              onChange: (v) => {
                setPicked(v)
                setAll(false)
                setConflicts([])
              },
              round: round.files.length,
              conv: conv.files.length,
            }
      }
      files={files.map((f) => ({ ...f, added: added.has(f.path) }))}
      first={first}
      all={all}
      onAll={() => setAll(!all)}
      reverted={reverted}
      onOpen={setOpen}
      tag={tag}
      revert={{
        label: isRound ? t('撤销这一轮') : t('撤销'),
        title: task.working
          ? t('对话正在执行，等这一轮结束后再撤销')
          : isRound
            ? t('撤销这一轮改的所有文件')
            : t('撤销这个对话改的所有文件'),
        disabled: task.working,
        onClick: () => setConfirm(true),
      }}
      footer={
        <>
          {/* 这一轮从哪算起：用户分得清「这一轮」到底是哪一段 */}
          {since && !reverted && (
            <ChangesCardNote title={since.text}>
              {t('这一轮 = 你 {time} 说「{text}」之后到它停下；切到「整个对话」看全部 {n} 个文件', {
                time: since.time,
                text: since.short,
                n: conv.files.length,
              })}
            </ChangesCardNote>
          )}
          {/* 同目录别的对话那段时间改的文件已经剔除（server/turn/owners.ts）：说一句，免得用户以为少记了，悬停能看到是哪些 */}
          {!reverted && ch.others.length > 0 && (
            <ChangesCardNote title={ch.others.join('\n')}>
              {t('另有 {n} 个文件是同目录里别的对话改的，没有算进来，撤销时也不会动', { n: ch.others.length })}
            </ChangesCardNote>
          )}
        </>
      }
    >
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
      <TurnDiffDialog
        load={(p) => api.convDiff(task.id, p, isRound ? 'round' : 'conv')}
        files={files}
        path={open}
        onPath={setOpen}
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={isRound ? t('撤销这一轮的改动？') : t('撤销这个对话的改动？')}
        description={
          isRound
            ? t(
                '{n} 个文件会恢复成这一轮改之前的样子，这一轮新建的文件会被删除；更早几轮的改动、你或其他对话之后在这些文件里的改动会保留。改到同一处时不会撤销，会列出冲突。',
                { n: files.length },
              )
            : t(
                '{n} 个文件会恢复成这个对话改之前的样子，对话里新建的文件会被删除；你或其他对话之后在这些文件里的改动会保留。改到同一处时不会撤销，会列出冲突。',
                { n: files.length },
              )
        }
        confirmText={t('撤销')}
        onConfirm={revert}
      />
    </ChangesCard>
  )
}

/** 这一轮从哪句话算起：用户最后一次发话的时间（时:分）和开头几个字 */
function roundStart(messages: Pick<TaskMessage, 'role' | 'text' | 'at'>[]) {
  const m = [...messages].reverse().find((x) => x.role === 'user')
  if (!m) return null
  const text = m.text.replace(/\s+/g, ' ').trim()
  const d = new Date(m.at)
  const time = Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return { time, text, short: text.length > 16 ? `${text.slice(0, 16)}…` : text }
}

/**
 * 这一段里哪些文件是新建的（文件行标「新建」）：和本轮产出同一个接口按快照查 git 状态（server/turn/outputs.ts）。
 * 查不到（导入的对话、目录没了）就都不标，不影响卡片
 */
function useAddedFiles(taskId: string, ch: ConvChanges) {
  const msgs = ch.turns.slice(-50)
  const paths = ch.files.map((f) => f.path).slice(0, 200)
  const key = `${msgs.join(',')}|${paths.join('\n')}`
  const [got, setGot] = useState<{ key: string; added: Set<string> } | null>(null)
  useEffect(() => {
    if (!paths.length) return
    let off = false
    api.turnOutputs(taskId, msgs, paths).then(
      (r) => !off && setGot({ key, added: new Set(r.files.filter((f) => f.status === 'added').map((f) => f.path)) }),
      () => !off && setGot({ key, added: new Set() }),
    )
    return () => {
      off = true
    }
    // key 已经包含了轮次和文件：msgs、paths 每次渲染都是新数组，不能放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, key])
  return got?.key === key ? got.added : EMPTY
}
const EMPTY = new Set<string>()

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
