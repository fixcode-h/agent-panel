import { useMemo, useState } from 'react'
import { Archive, Search, Square } from 'lucide-react'
import { t } from '@shared/i18n'
import { OVERVIEW_GROUPS, overviewRows, type OverviewGroup, type OverviewRow } from '@shared/overview'
import { taskWaitText, timeAgo } from '@shared/task'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { fmtTokens } from '@/lib/tasks'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { TaskRowStatus } from '@/components/ui/sidebar'
import { PageFrame } from '@/components/library/parts'

type Tab = 'all' | OverviewGroup

const GROUP_LABEL: Record<OverviewGroup, string> = {
  you: t('等你处理'),
  stalled: t('停住了'),
  running: t('执行中'),
  rest: t('最近'),
}

/** 「最近」那一组只列这么多：总览是看「现在要管什么」的，历史在侧栏和搜索里 */
const REST_MAX = 30

/**
 * 对话总览：所有项目的顶层对话按「要不要你管」分组（分组规则见 shared/overview.ts），
 * 可以多选后一起停止或归档。点一行打开那个对话
 */
export function OverviewPage() {
  const { tasks, projects, upsertTask } = useData()
  const { go } = useNav()
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => overviewRows(tasks), [tasks])
  const count = (g: OverviewGroup) => rows.filter((r) => r.group === g).length
  const q = query.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (tab === 'all' || r.group === tab) &&
      (!q ||
        r.task.title.toLowerCase().includes(q) ||
        (projects.find((p) => p.id === r.task.projectId)?.name ?? '').toLowerCase().includes(q)),
  )
  const projectName = (id: string) => (id ? (projects.find((p) => p.id === id)?.name ?? t('已删除的项目')) : t('聊天'))
  const open = (r: OverviewRow) =>
    r.task.projectId
      ? go({ page: 'projects', id: r.task.projectId, sub: r.task.id })
      : go({ page: 'chat', id: r.task.id })

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  /** 多选的批量操作：一条失败不挡别的，最后把失败的报出来 */
  const batch = async (run: (id: string) => Promise<unknown>, done: (n: number) => string) => {
    setBusy(true)
    const ids = [...picked]
    const failed: string[] = []
    for (const id of ids)
      try {
        const tk = await run(id)
        if (tk && typeof tk === 'object' && 'id' in tk) upsertTask(tk as Parameters<typeof upsertTask>[0])
      } catch (e) {
        failed.push(`${tasks.find((x) => x.id === id)?.title ?? id}：${(e as Error).message}`)
      }
    setBusy(false)
    setPicked(new Set())
    if (failed.length) toast.error(failed.join('\n'))
    else toast.success(done(ids.length))
  }

  return (
    <PageFrame
      title={t('对话总览')}
      intro={t(
        '所有项目的对话一页看：先列等你处理的，再列停住了的（计划没做完、也没在跑）和执行中的。可以多选后一起停止或归档。',
      )}
      align="left"
      actions={
        <div className="relative w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('搜标题或项目')}
            aria-label={t('搜标题或项目')}
            className="pl-8"
          />
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Tab>
          label={t('分组')}
          value={tab}
          onChange={setTab}
          options={[
            { id: 'all', label: t('全部 {n}', { n: rows.length }) },
            ...(['you', 'stalled', 'running'] as const).map((g) => ({
              id: g,
              label: `${GROUP_LABEL[g]} ${count(g)}`,
              dot: g === 'you' && count(g) ? t('有要你处理的对话') : undefined,
            })),
          ]}
        />
        {picked.size > 0 && (
          <div className="ml-auto flex items-center gap-2" data-overview-batch>
            <span className="text-[0.8125rem] text-muted">{t('已选 {n} 个', { n: picked.size })}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void batch(
                  (id) => api.stopTaskSummary(id),
                  (n) => t('已停止 {n} 个对话', { n }),
                )
              }
            >
              <Square className="h-3.5 w-3.5" />
              {t('停止')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void batch(
                  (id) => api.archiveTaskSummary(id, true),
                  (n) => t('已归档 {n} 个对话', { n }),
                )
              }
            >
              <Archive className="h-3.5 w-3.5" />
              {t('归档')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPicked(new Set())}>
              {t('取消选择')}
            </Button>
          </div>
        )}
      </div>

      {!shown.length ? (
        <EmptyPanel>{q ? t('没有符合的对话') : t('这一组现在没有对话')}</EmptyPanel>
      ) : (
        <div className="flex flex-col gap-6" data-overview>
          {OVERVIEW_GROUPS.map((g) => {
            const list = shown.filter((r) => r.group === g)
            if (!list.length) return null
            const cut = g === 'rest' ? list.slice(0, REST_MAX) : list
            return (
              <section key={g} aria-label={GROUP_LABEL[g]} data-overview-group={g}>
                <h2 className="mb-1.5 flex items-center gap-2 px-2 text-xs font-medium text-muted">
                  {GROUP_LABEL[g]}
                  <span className="font-mono text-subtle tabular-nums">{list.length}</span>
                </h2>
                <ul className="flex flex-col">
                  {cut.map((r) => (
                    <Row
                      key={r.task.id}
                      r={r}
                      project={projectName(r.task.projectId)}
                      picked={picked.has(r.task.id)}
                      onPick={() => toggle(r.task.id)}
                      onOpen={() => open(r)}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </PageFrame>
  )
}

function Row({
  r,
  project,
  picked,
  onPick,
  onOpen,
}: {
  r: OverviewRow
  project: string
  picked: boolean
  onPick: () => void
  onOpen: () => void
}) {
  const { task, state } = r
  const busy = state === 'running' || state === 'waiting'
  const note =
    state === 'waiting'
      ? taskWaitText(task)
      : r.group === 'stalled'
        ? t('计划 {done}/{total}，没在执行', { done: r.plan!.done, total: r.plan!.total })
        : r.plan
          ? t('计划 {done}/{total}', { done: r.plan.done, total: r.plan.total })
          : ''
  return (
    <li
      className={cn(
        'group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-sel/60',
        picked && 'bg-accent-soft hover:bg-accent-soft',
      )}
      data-overview-row={task.id}
    >
      <Checkbox checked={picked} onChange={onPick} ariaLabel={t('选择「{title}」', { title: task.title })} />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer flex-col text-left">
        <span className="truncate text-[0.875rem] text-fg">{task.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="truncate">{project}</span>
          {note && (
            <>
              <span className="text-subtle">·</span>
              <span className={cn('truncate', r.group === 'stalled' && 'text-warning')}>{note}</span>
            </>
          )}
        </span>
      </button>
      <span className="hidden w-20 shrink-0 text-right font-mono text-xs text-subtle tabular-nums sm:block">
        {r.tokens ? fmtTokens(r.tokens) : ''}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-subtle tabular-nums">{timeAgo(task.updatedAt)}</span>
      <span className="flex w-24 shrink-0 justify-end">
        <TaskRowStatus
          needs={state === 'needs'}
          kids={busy ? r.kidsBusy : 0}
          running={busy}
          failed={state === 'failed'}
          unread={r.group === 'you' && state === 'done'}
        />
      </span>
    </li>
  )
}
