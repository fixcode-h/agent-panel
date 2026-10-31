import { useMemo, useState } from 'react'
import {
  Archive,
  BellDot,
  CirclePause,
  Folder,
  History,
  Layers,
  LoaderCircle,
  MessageSquare,
  Search,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react'
import { t } from '@shared/i18n'
import { OVERVIEW_GROUPS, overviewRows, type OverviewGroup, type OverviewRow } from '@shared/overview'
import { taskWaitText, timeAgo } from '@shared/task'
import { api } from '@/lib/api'
import { useData, useNav, useTasks } from '@/lib/data'
import { fmtTokens } from '@/lib/tasks'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { StatusPill } from '@/components/ui/status-pill'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { PageFrame } from '@/components/library/parts'

type Tab = 'all' | OverviewGroup

const GROUP_LABEL: Record<OverviewGroup, string> = {
  you: t('等你处理'),
  stalled: t('停住了'),
  running: t('执行中'),
  rest: t('最近'),
}

/** 每组一句话说明它为什么在这一组，规则和 shared/overview.ts 的分组一致 */
const GROUP_HINT: Record<OverviewGroup, string> = {
  you: t('有提问要回答、失败了，或做完还没看'),
  stalled: t('计划没做完，也没在执行'),
  running: t('正在执行，或在等子对话、后台命令的结果'),
  rest: t('已经做完或停下的对话'),
}

/** 分组的图标和颜色：图标块和统计卡片共用，状态色和 StatusPill 同一套（等你琥珀以外用强调色，是因为它是页面的重点） */
const GROUP_TONE: Record<Tab, { icon: LucideIcon; tile: string }> = {
  all: { icon: Layers, tile: 'bg-sel text-muted' },
  you: { icon: BellDot, tile: 'bg-accent-soft text-accent-text' },
  stalled: { icon: CirclePause, tile: 'bg-warning/12 text-warning' },
  running: { icon: LoaderCircle, tile: 'bg-run-soft text-run' },
  rest: { icon: History, tile: 'bg-sel text-subtle' },
}

/** 「最近」那一组只列这么多：总览是看「现在要管什么」的，历史在侧栏和搜索里 */
const REST_MAX = 30

/**
 * 对话总览：所有项目的顶层对话按「要不要你管」分组（分组规则见 shared/overview.ts），
 * 顶部四张统计卡片兼做筛选；每组一张卡片，勾选后底部浮出批量停止 / 归档。点一行打开那个对话
 */
export function OverviewPage() {
  const { projects, upsertTask } = useData()
  const { tasks } = useTasks()
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
  /** 组头的勾选：整组都选上了就整组取消，否则整组选上 */
  const toggleAll = (ids: string[]) =>
    setPicked((prev) => {
      const next = new Set(prev)
      const all = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (all) next.delete(id)
        else next.add(id)
      }
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

  const stats: { id: Tab; label: string; n: number }[] = [
    { id: 'you', label: GROUP_LABEL.you, n: count('you') },
    { id: 'stalled', label: GROUP_LABEL.stalled, n: count('stalled') },
    { id: 'running', label: GROUP_LABEL.running, n: count('running') },
    { id: 'all', label: t('全部对话'), n: rows.length },
  ]

  return (
    <PageFrame
      title={t('对话总览')}
      intro={t('所有项目的对话一页看，按要不要你管分组。点卡片只看那一组，勾选后可以一起停止或归档。')}
      align="left"
      actions={
        <div className="relative w-56 max-sm:w-full">
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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" role="group" aria-label={t('分组')} data-overview-stats>
        {stats.map((s) => (
          <StatCard
            key={s.id}
            id={s.id}
            label={s.label}
            n={s.n}
            on={tab === s.id}
            // 再点一次选中的卡片回到「全部」，不用去找另一张
            onClick={() => setTab(tab === s.id ? 'all' : s.id)}
          />
        ))}
      </div>

      {!shown.length ? (
        <EmptyPanel size="xl">{q ? t('没有符合的对话') : t('这一组现在没有对话')}</EmptyPanel>
      ) : (
        <div className="flex flex-col gap-4" data-overview>
          {OVERVIEW_GROUPS.map((g) => {
            const list = shown.filter((r) => r.group === g)
            if (!list.length) return null
            const cut = g === 'rest' ? list.slice(0, REST_MAX) : list
            const ids = cut.map((r) => r.task.id)
            return (
              <Card as="section" key={g} aria-label={GROUP_LABEL[g]} data-overview-group={g} className="py-1.5">
                <header className="flex min-w-0 items-center gap-2.5 px-4 pt-2 pb-1.5">
                  <Checkbox
                    checked={ids.every((id) => picked.has(id))}
                    onChange={() => toggleAll(ids)}
                    ariaLabel={t('选择「{title}」里的全部对话', { title: GROUP_LABEL[g] })}
                  />
                  <h2 className="text-body font-medium text-fg">{GROUP_LABEL[g]}</h2>
                  <span className="rounded-full bg-sel px-1.5 text-caption text-muted tabular-nums">{list.length}</span>
                  <span className="hidden min-w-0 truncate text-xs text-subtle sm:block">{GROUP_HINT[g]}</span>
                </header>
                <ul className="flex flex-col gap-0.5 px-1.5">
                  {cut.map((r) => (
                    <Row
                      key={r.task.id}
                      r={r}
                      project={projectName(r.task.projectId)}
                      picked={picked.has(r.task.id)}
                      selecting={picked.size > 0}
                      onPick={() => toggle(r.task.id)}
                      onOpen={() => open(r)}
                    />
                  ))}
                </ul>
                {list.length > cut.length && (
                  <p className="px-4 pt-1.5 pb-1 text-xs text-subtle">
                    {t('还有 {n} 个更早的对话，在侧栏或搜索里找', { n: list.length - cut.length })}
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {picked.size > 0 && (
        // 浮在滚动区底部：列表很长时勾完不用滚回顶上去点按钮
        <div
          className="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 self-center rounded-xl border border-line frost-card py-2 pr-2 pl-4 shadow-card"
          data-overview-batch
        >
          <span className="mr-2 text-body text-fg tabular-nums">{t('已选 {n} 个', { n: picked.size })}</span>
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
            <X className="h-3.5 w-3.5" />
            {t('取消选择')}
          </Button>
        </div>
      )}
    </PageFrame>
  )
}

/** 顶部的统计卡片：图标块 + 名字 + 大号计数，点了只看这一组；选中靠强调色浅底，不描边 */
function StatCard({
  id,
  label,
  n,
  on,
  onClick,
}: {
  id: Tab
  label: string
  n: number
  on: boolean
  onClick: () => void
}) {
  const { icon: Icon, tile } = GROUP_TONE[id]
  return (
    <Card
      as="button"
      interactive
      aria-pressed={on}
      onClick={onClick}
      data-overview-stat={id}
      className={cn('flex items-center gap-3 px-4 py-3', on && 'bg-accent-soft hover:bg-accent-soft')}
    >
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', tile)}>
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={cn('truncate text-xs', on ? 'text-accent-text' : 'text-muted')}>{label}</span>
        <span className={cn('text-xl leading-tight font-semibold tabular-nums', n ? 'text-fg' : 'text-subtle')}>
          {n}
        </span>
      </span>
    </Card>
  )
}

function Row({
  r,
  project,
  picked,
  selecting,
  onPick,
  onOpen,
}: {
  r: OverviewRow
  project: string
  picked: boolean
  /** 已经勾了别的行：所有行都直接露出勾选框，不用一行行悬停 */
  selecting: boolean
  onPick: () => void
  onOpen: () => void
}) {
  const { task, state, plan } = r
  const busy = state === 'running' || state === 'waiting'
  const note = state === 'waiting' ? taskWaitText(task) : r.group === 'stalled' ? t('没在执行') : ''
  const ProjectIcon = task.projectId ? Folder : MessageSquare
  const showBox = picked || selecting
  return (
    <li
      className={cn(
        'group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-sel/60',
        picked && 'bg-accent-soft/70 hover:bg-accent-soft',
      )}
      data-overview-row={task.id}
    >
      {/* 行首平时是对话类型的图标，悬停或进入多选后换成勾选框 */}
      <span className="relative grid h-8 w-8 shrink-0 place-items-center">
        <span
          aria-hidden
          className={cn(
            'grid h-8 w-8 place-items-center rounded-lg bg-sel text-muted transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 [@media(hover:none)]:opacity-0',
            showBox && 'opacity-0',
          )}
        >
          <ProjectIcon className="h-4 w-4" />
        </span>
        <Checkbox
          checked={picked}
          onChange={onPick}
          ariaLabel={t('选择「{title}」', { title: task.title })}
          className={cn(
            'absolute inset-0 grid place-items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
            showBox && 'opacity-100',
          )}
        />
      </span>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left">
        <span className="truncate text-prose text-fg">{task.title}</span>
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
      <span className="hidden w-28 shrink-0 flex-col gap-1 md:flex">
        {plan && (
          <>
            <span className="text-caption text-subtle tabular-nums">
              {t('计划 {done}/{total}', { done: plan.done, total: plan.total })}
            </span>
            <Progress
              value={plan.done}
              max={plan.total}
              size="xs"
              raw
              tone={r.group === 'stalled' ? 'warning' : busy ? 'run' : 'accent'}
              label={t('计划进度')}
            />
          </>
        )}
      </span>
      <span className="hidden w-16 shrink-0 text-right font-mono text-xs text-subtle tabular-nums sm:block">
        {r.tokens ? fmtTokens(r.tokens) : ''}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-subtle tabular-nums">{timeAgo(task.updatedAt)}</span>
      <span className="flex w-24 shrink-0 justify-end max-sm:w-auto">
        <RowStatus r={r} busy={busy} />
      </span>
    </li>
  )
}

/** 行尾状态：口径和侧栏的 TaskRowStatus 一样，这里统一画成胶囊，做完没看也写出字来，扫一眼就知道是哪种 */
function RowStatus({ r, busy }: { r: OverviewRow; busy: boolean }) {
  const { state } = r
  if (state === 'needs') return <StatusPill tone="wait">{t('等你回复')}</StatusPill>
  if (busy && r.kidsBusy > 0)
    return (
      <StatusPill tone="run" spin>
        {t('{n} 子对话', { n: r.kidsBusy })}
      </StatusPill>
    )
  if (busy)
    return (
      <StatusPill tone="run" spin>
        {t('执行中')}
      </StatusPill>
    )
  if (state === 'failed') return <StatusPill tone="err">{t('失败')}</StatusPill>
  if (r.group === 'you' && state === 'done') return <StatusPill tone="ok">{t('待查看')}</StatusPill>
  return null
}
