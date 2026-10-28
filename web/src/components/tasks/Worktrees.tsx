import { useEffect, useState, useSyncExternalStore } from 'react'
import * as D from '@radix-ui/react-dialog'
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Copy,
  GitBranch,
  GitMerge,
  Loader2,
  MessageSquare,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import type { Task } from '@shared/schema'
import { api, type WorktreeItem } from '@/lib/api'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/copy-text'
import { groupWorktrees } from '@/lib/worktrees'
import { t } from '@shared/i18n'
import { childHoldText } from '@shared/task'

/**
 * 独立分支的实际情况（合没合进原分支）要问 git，同一个对话页里输入框上下两处都要用：
 * 按对话 id 缓存一份，谁合并、删除了就让大家一起重新读。
 */
const cache = new Map<string, WorktreeItem[]>()
const loading = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((f) => f())
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}

export function refreshWorktrees(taskId: string) {
  const running = loading.get(taskId)
  if (running) return running
  const p = api
    .taskWorktrees(taskId)
    .then((r) => void cache.set(taskId, r.items))
    .catch(() => {})
    .finally(() => {
      loading.delete(taskId)
      notify()
    })
  loading.set(taskId, p)
  return p
}

/** 这个对话（和名下子对话）的独立分支；key 变了（这一轮结束、状态变了）就重新读 */
export function useWorktrees(taskId: string, key: string, enabled = true) {
  const items = useSyncExternalStore(subscribe, () => cache.get(taskId))
  useEffect(() => {
    if (enabled) void refreshWorktrees(taskId)
  }, [taskId, key, enabled])
  return items
}

/** 页面上用来决定什么时候重新读的指纹：执行状态、这一轮的结束时间、分支状态 */
export const worktreeKey = (task: Task) =>
  `${task.status}:${task.working}:${task.turnDoneAt ?? ''}:${task.worktree?.state ?? ''}:${task.childrenWorking ?? 0}`

/** 还有东西没合回原分支：分支上有原分支没有的提交，或者目录里有没提交的改动。两边都为 0 时没有可合的东西 */
const pending = (x: WorktreeItem) => x.ahead > 0 || x.dirty > 0

/** 需要合并（界面才给合并按钮）：分支还在、状态还是 active、并且真有东西没合回去 */
export const needsMerge = (x: WorktreeItem) => x.state === 'active' && !x.merged && pending(x)

/** 还没合回原分支、还能处理的 */
export const unmergedOf = (items: WorktreeItem[] | undefined) => (items ?? []).filter(needsMerge)

/** 绿色的勾：改动都在原分支里了；感叹号：还有没合并的 */
export function WorktreeMark({ item, className }: { item: WorktreeItem; className?: string }) {
  if (item.merged)
    return <CircleCheck className={cn('h-3.5 w-3.5 shrink-0 text-success', className)} aria-label={t('已合并')} />
  return <CircleAlert className={cn('h-3.5 w-3.5 shrink-0 text-warning', className)} aria-label={t('未合并')} />
}

/** 一句话说清这个分支现在的情况 */
export function worktreeSummary(item: WorktreeItem) {
  const base = item.baseBranch || t('原分支')
  if (item.state === 'discarded') return t('已删除，改动没有合并')
  if (item.state === 'merged') return t('已合并到「{branch}」，分支已删除', { branch: item.note || base })
  if (item.working) return t('正在执行，不改动原目录')
  // 没有提交也没有未提交的文件就是合过了：不能给按钮（见 unmergedOf）却拼出「未合并到「…」：」后面空着这种句子
  if (item.merged || !pending(item)) {
    // 合回去了但还没彻底完成（这一轮还在跑、计划没做完、后台命令还在跑…）：说清为什么还留着分支，别让人以为卡住了
    const holds = item.holds ?? []
    if (holds.length) return t('已在「{branch}」里，独立分支先留着：{why}', { branch: base, why: childHoldText(holds) })
    return t('已在「{branch}」里', { branch: base })
  }
  const parts: string[] = []
  if (item.ahead) parts.push(t('{n} 个提交', { n: item.ahead }))
  if (item.dirty) parts.push(t('{n} 个文件未提交', { n: item.dirty }))
  return t('未合并到「{branch}」：{what}', { what: parts.join(t('、')), branch: base })
}

/** 交给 Agent 的合并要求：先在独立分支里把原分支合进来解决冲突，再合回原目录 */
function aiMergeText(item: WorktreeItem) {
  const base = item.baseBranch || '原分支'
  const last = item.child
    ? '3. 按项目的测试步骤在独立分支里验证通过后调用 submit_merge（tests 写上跑了什么），交给面板合回原分支。'
    : `3. 到原目录 ${item.home} 里（应该在「${base}」分支上）执行 git merge --no-ff ${item.branch}。原目录有未提交的改动挡住时先停下告诉我，不要丢弃它们。`
  return `请把独立分支 ${item.branch} 合并回「${base}」：
1. 先把独立分支目录里还没提交的改动提交到这个分支。
2. 在独立分支里合入「${base}」的最新提交（git merge ${base}），有冲突就逐个解决，跑必要的检查后提交。
${last}
合并完告诉我结果：合回「${base}」就算做完了。推送不属于合并这一步，推不推由版本管理或用户另定；合并过程中不要推送到远端，也不要删除分支。`
}

/** 让各自的对话用 AI 合并：消息发给分支所属的对话 */
export async function aiMerge(items: WorktreeItem[]) {
  for (const x of items) await api.sendMessage(x.taskId, aiMergeText(x))
}

/** 合并、删除独立分支的动作；合并有冲突时提示可以交给 AI */
export function useWorktreeActions(rootId: string) {
  const { upsertTask } = useData()
  const [busy, setBusy] = useState('')
  const [removing, setRemoving] = useState<WorktreeItem | null>(null)
  const done = () => refreshWorktrees(rootId)
  const merge = async (item: WorktreeItem) => {
    setBusy(item.taskId)
    try {
      const r = await api.mergeWorktree(item.taskId)
      upsertTask(r.task)
      toast.success(t('已合并到「{branch}」', { branch: r.into }))
    } catch (e) {
      const conflict = !!((e as { body?: { conflict?: boolean } }).body ?? {}).conflict
      toast.error((e as Error).message, {
        duration: 12_000,
        ...(conflict
          ? {
              action: {
                label: t('用 AI 合并'),
                onClick: () =>
                  void aiMerge([item]).then(
                    () => toast.success(t('已交给 AI 合并，结果会在对话里回复')),
                    (err) => toast.error((err as Error).message),
                  ),
              },
            }
          : {}),
      })
    } finally {
      setBusy('')
      await done()
    }
  }
  const remove = async (item: WorktreeItem) => {
    setBusy(item.taskId)
    try {
      upsertTask(await api.discardWorktree(item.taskId))
      toast.success(t('已删除独立分支 {name}', { name: item.branch }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
      setRemoving(null)
      await done()
    }
  }
  const confirm = (
    <ConfirmDialog
      open={!!removing}
      onOpenChange={(o) => !o && setRemoving(null)}
      title={t('删除独立分支 {name}？', { name: removing?.branch ?? '' })}
      description={
        removing && !removing.merged
          ? t('这个分支还有改动没合并到「{branch}」，删除后这些改动会丢掉。原目录不受影响。', {
              branch: removing.baseBranch || t('原分支'),
            })
          : t('改动都已经在原分支里了，删除分支和它的工作目录不会丢东西。')
      }
      onConfirm={() => removing && remove(removing)}
    />
  )
  return { busy, merge, askRemove: setRemoving, confirm }
}

/** 菜单里的复制：成功提示「已复制」，失败提示「复制失败」 */
const copyValue = (text: string) => copyText(text, { done: t('已复制'), fail: t('复制失败') })

/** 右键菜单里一个操作的可用性：不能点时用 reason 说明原因，不要只变灰 */
type Availability = { ok: true } | { ok: false; reason: string }

/** 合并能不能点：行内按钮和右键菜单同一个判定，免得两边规矩不一致。busy 是这一行正在合并 / 删除 */
function mergeState(item: WorktreeItem, busy: boolean): Availability {
  if (item.state !== 'active') return { ok: false, reason: t('这个分支已经删除了') }
  if (busy) return { ok: false, reason: t('正在处理这个独立分支，等它结束') }
  if (item.working) return { ok: false, reason: t('对话正在执行，等这一轮结束后再合并') }
  if (!needsMerge(item)) return { ok: false, reason: t('这个分支没有要合回原分支的改动') }
  return { ok: true }
}

function removeState(item: WorktreeItem, busy: boolean): Availability {
  // 已经删掉的分支后端会直接拒（isolated 只认 active，见 server/tasks.ts 的 discard），
  // 不能给可点：否则用户确认一遍、才看到一条报错，行内按钮那边却根本没有这个入口
  if (item.state !== 'active') return { ok: false, reason: t('这个分支已经删除了') }
  if (busy) return { ok: false, reason: t('正在处理这个独立分支，等它结束') }
  if (item.working) return { ok: false, reason: t('对话正在执行，等这一轮结束后再删除独立分支') }
  return { ok: true }
}

/**
 * 不能用时的菜单项：不能用真 disabled。`menuItem` 上有 `data-[disabled]:pointer-events-none`，
 * 禁用后鼠标悬不上、原生 title 的原因根本上不来，点了也没反馈。改成 aria-disabled + 保留指针事件，
 * 鼠标能悬住看到原因，点了也把原因 toast 出来。
 */
function Unavailable({ why, danger, children }: { why: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <ContextMenuItem
      aria-disabled
      title={why}
      danger={danger}
      className="cursor-not-allowed opacity-50"
      onSelect={() => toast.error(why)}
    >
      {children}
    </ContextMenuItem>
  )
}

/** 弹窗里的一行独立分支：状态、分支名、从哪开的，合并和删除按钮（右键还有一组菜单） */
export function WorktreeRow({
  item,
  busy,
  onOpen,
  onMerge,
  onRemove,
}: {
  item: WorktreeItem
  busy: boolean
  /** 打开这一行对应的对话；当前对话自己那行不传，点不了 */
  onOpen?: () => void
  onMerge: () => void
  onRemove: () => void
}) {
  const active = item.state === 'active'
  const idle = active && !item.working
  const mergeable = mergeState(item, busy)
  const removable = removeState(item, busy)
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1 font-mono text-[0.75rem]">
        <span className="shrink-0 text-subtle">{item.baseBranch || 'HEAD'}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-subtle" />
        <span className={cn('min-w-0 truncate', active ? 'text-fg' : 'text-subtle line-through')} title={item.branch}>
          {item.branch}
        </span>
      </span>
      <span className="mt-0.5 block truncate text-[0.6875rem] text-subtle" title={item.path}>
        {item.child && <span className="text-muted">{item.title} · </span>}
        {worktreeSummary(item)}
      </span>
    </>
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-worktree-row={item.taskId}
          className="group -mx-1 flex min-w-0 items-start gap-2 rounded-md px-1 py-1 hover:bg-sel/60"
        >
          <span className="mt-px">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <WorktreeMark item={item} />}
          </span>
          {onOpen ? (
            // 原生按钮：Enter / Space 和鼠标点都一样；合并、删除是旁边的独立按钮，不会连带触发
            <button
              type="button"
              onClick={onOpen}
              title={t('在中间打开子对话「{title}」', { title: item.title })}
              aria-label={t('在中间打开子对话「{title}」', { title: item.title })}
              className="min-w-0 flex-1 cursor-pointer rounded-md text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              {body}
            </button>
          ) : (
            <div className="min-w-0 flex-1 cursor-default">{body}</div>
          )}
          {idle && (
            <span className="flex shrink-0 items-center gap-0.5">
              {needsMerge(item) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onMerge}
                  title={t('合并到「{branch}」', { branch: item.baseBranch || t('原分支') })}
                  className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-sel hover:text-fg disabled:opacity-50"
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  {t('合并')}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={onRemove}
                title={t('删除独立分支')}
                aria-label={t('删除独立分支')}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      {/* 右键菜单是行内按钮的补充，合并 / 删除走同一套回调，不另写逻辑 */}
      <ContextMenuContent>
        {onOpen ? (
          <ContextMenuItem title={t('在中间打开子对话「{title}」', { title: item.title })} onSelect={() => onOpen()}>
            <MessageSquare className="h-3.5 w-3.5 text-subtle" />
            {t('打开对话')}
          </ContextMenuItem>
        ) : (
          // 当前对话自己那行：点了也不知道要打开什么，说清楚是它自己的分支
          <Unavailable why={t('这是当前对话自己的分支')}>
            <MessageSquare className="h-3.5 w-3.5 text-subtle" />
            {t('打开对话')}
          </Unavailable>
        )}
        <ContextMenuSeparator />
        {mergeable.ok ? (
          <ContextMenuItem
            title={t('合并到「{branch}」', { branch: item.baseBranch || t('原分支') })}
            onSelect={onMerge}
          >
            <GitMerge className="h-3.5 w-3.5 text-subtle" />
            {t('合并到原分支')}
          </ContextMenuItem>
        ) : (
          <Unavailable why={mergeable.reason}>
            <GitMerge className="h-3.5 w-3.5 text-subtle" />
            {t('合并到原分支')}
          </Unavailable>
        )}
        {mergeable.ok ? (
          <ContextMenuItem
            title={t('把合并要求发给这个分支的对话，由 AI 解决冲突后合回原分支')}
            onSelect={() =>
              void aiMerge([item]).then(
                () => toast.success(t('已交给 AI 合并，结果会在对话里回复')),
                (e) => toast.error((e as Error).message),
              )
            }
          >
            <Sparkles className="h-3.5 w-3.5 text-subtle" />
            {t('用 AI 合并')}
          </ContextMenuItem>
        ) : (
          <Unavailable why={mergeable.reason}>
            <Sparkles className="h-3.5 w-3.5 text-subtle" />
            {t('用 AI 合并')}
          </Unavailable>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem title={item.branch} onSelect={() => copyValue(item.branch)}>
          <Copy className="h-3.5 w-3.5 text-subtle" />
          {t('复制分支名')}
        </ContextMenuItem>
        <ContextMenuItem title={item.path} onSelect={() => copyValue(item.path)}>
          <Copy className="h-3.5 w-3.5 text-subtle" />
          {t('复制路径')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {removable.ok ? (
          <ContextMenuItem danger title={t('删除独立分支')} onSelect={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
            {t('删除独立分支')}
          </ContextMenuItem>
        ) : (
          <Unavailable why={removable.reason} danger>
            <Trash2 className="h-3.5 w-3.5" />
            {t('删除独立分支')}
          </Unavailable>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 环境弹窗里的「独立分支」一节：对话自己的和名下子对话的 */
export function WorktreeSection({
  task,
  onOpenChild,
}: {
  task: Task
  /** 点中间那行打开对应的子对话；当前对话自己那行不响应 */
  onOpenChild?: (id: string) => void
}) {
  const items = useWorktrees(task.id, worktreeKey(task))
  const actions = useWorktreeActions(task.id)
  if (!items?.length) return null
  const open = unmergedOf(items).length
  // 按删除与否分组：还留着的（active）和已经删掉的（merged / discarded）。组内保持父对话在前、其余按创建时间
  const groups = groupWorktrees(items)
  const row = (x: WorktreeItem) => (
    <WorktreeRow
      key={x.taskId}
      item={x}
      busy={actions.busy === x.taskId}
      onOpen={x.child && onOpenChild ? () => onOpenChild(x.taskId) : undefined}
      onMerge={() => void actions.merge(x)}
      onRemove={() => actions.askRemove(x)}
    />
  )
  const group = (key: 'live' | 'removed') => (
    <div data-worktree-group={key} className="flex flex-col gap-1">
      {/* 组标题带数量：两组都显示标题，一眼看出哪些删了、哪些还在 */}
      <div className="flex items-center gap-2 pl-1 text-[0.6875rem] text-subtle">
        <span className="flex-1">{key === 'live' ? t('未删除') : t('已删除')}</span>
        <span className="tabular-nums">{groups[key].length}</span>
      </div>
      {groups[key].map(row)}
    </div>
  )
  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <div className="flex items-center gap-2 text-subtle">
        <GitBranch className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t('独立分支')}</span>
        {open > 0 && <span className="text-warning">{t('{n} 个没合并', { n: open })}</span>}
      </div>
      {/* 空组不渲染，只显示有内容的那组 */}
      {groups.live.length > 0 && group('live')}
      {groups.removed.length > 0 && group('removed')}
      {actions.confirm}
    </div>
  )
}

/**
 * 删除对话的确认：先查它（和子对话）的独立分支，有没合并的就警告，
 * 可以交给 AI 合并（不删），也可以直接删除（分支一起删掉）。
 */
export function DeleteTaskDialog({
  task,
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: {
  task: Task
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  onConfirm: () => Promise<unknown> | unknown
}) {
  const [items, setItems] = useState<WorktreeItem[] | null>(null)
  const [pending, setPending] = useState<'' | 'ai' | 'delete'>('')
  useEffect(() => {
    if (!open) return
    let alive = true
    setItems(null)
    api
      .taskWorktrees(task.id)
      .then((r) => alive && setItems(r.items))
      // 查不到就按没有独立分支处理，不挡住删除
      .catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [open, task.id])
  const left = unmergedOf(items ?? undefined)
  const kept = (items ?? []).filter((x) => x.state === 'active' && !needsMerge(x)).length
  const run = async (what: 'ai' | 'delete') => {
    if (pending) return
    setPending(what)
    try {
      if (what === 'delete') await onConfirm()
      else {
        await aiMerge(left)
        toast.success(t('已交给 AI 合并，合并完再删除对话'))
        onOpenChange(false)
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPending('')
    }
  }
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-card p-6 shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none">
          <D.Title className="text-[0.9375rem] font-semibold">{title}</D.Title>
          <D.Description className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">
            {description}
            {kept > 0 && !left.length && ` ${t('它的独立分支已经合并，恢复后照常可用。')}`}
          </D.Description>
          {!items && (
            <p className="mt-3 flex items-center gap-2 text-[0.8125rem] text-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('正在检查独立分支…')}
            </p>
          )}
          {left.length > 0 && (
            <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-warning">
                <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                {t('有 {n} 个独立分支还没合并：删除后跟着对话进回收站，永久删除时才一起清掉', { n: left.length })}
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {left.map((x) => (
                  <div key={x.taskId} className="min-w-0 text-xs">
                    <div className="flex min-w-0 items-center gap-1 font-mono">
                      <span className="shrink-0 text-subtle">{x.baseBranch || 'HEAD'}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-subtle" />
                      <span className="min-w-0 truncate text-fg">{x.branch}</span>
                    </div>
                    <p className="truncate text-subtle">
                      {x.child && `${x.title} · `}
                      {worktreeSummary(x)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('取消')}
            </Button>
            {left.length > 0 && (
              <Button
                variant="secondary"
                disabled={!!pending}
                title={t('把合并要求发给分支所在的对话，由 AI 解决冲突后合回原分支；对话先不删除')}
                onClick={() => void run('ai')}
              >
                {pending === 'ai' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {t('用 AI 合并')}
              </Button>
            )}
            <Button variant="danger" disabled={!items || !!pending} onClick={() => void run('delete')}>
              {pending === 'delete' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('删除')}
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
