import { useMemo } from 'react'
import { GitMerge, Hourglass, Layers, Repeat, Undo2, Workflow } from 'lucide-react'
import { agentStats, flowHotspots, flowReworks, type FlowBrief, type FlowSummary } from '@shared/agents/stats'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { fmtTokens } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { StatTile } from '@/components/ui/stat-tile'
import { stayText } from '@/components/overview/BugOverview'

/** 平均值最多一位小数，整数不带 .0；没有样本画成「—」 */
const num = (v: number | undefined) => (v === undefined ? '—' : String(Math.round(v * 10) / 10))
const pct = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v * 100)}%`)

/** 「返工最多」列多少个：这里是找问题的入口，不是全表 */
const HOT_MAX = 10

/**
 * 总览页的「流程」视图（扩展 4）：所有 Agent 模式对话（含子对话）被面板推了几次、交代结束时卡住多少、
 * 评审退回、合回失败、等你多久，按角色分开看，再列出返工最多的对话。
 * 数据由页面取好传进来（GET /tasks/flow），按页头搜索词筛过再汇总；这里只管画，点一行交给页面打开那个对话
 */
export function FlowOverview({
  briefs,
  query,
  projectName,
  onOpen,
}: {
  /** 还没取到是 undefined：先不画空态，免得闪一下「还没有对话」 */
  briefs: FlowBrief[] | undefined
  /** 页头搜索框里的字：搜标题、项目名 */
  query: string
  projectName: (id: string) => string
  onOpen: (b: FlowBrief) => void
}) {
  const { agents } = useData()
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      (briefs ?? []).filter(
        (b) => !q || b.title.toLowerCase().includes(q) || projectName(b.projectId).toLowerCase().includes(q),
      ),
    // projectName 每次渲染都是新函数，项目名变了 briefs 也会跟着刷新，不用跟它
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [briefs, q],
  )
  const s = useMemo(() => agentStats(shown), [shown])
  const hot = useMemo(() => flowHotspots(shown, HOT_MAX), [shown])
  if (!briefs) return null
  if (!shown.length)
    return (
      <EmptyPanel size="xl">
        {q
          ? t('没有符合的对话')
          : t('还没有项目里的对话。在项目里发起对话后，面板推进、评审、合回的数字会汇总在这里。')}
      </EmptyPanel>
    )
  const roleName = (id: string) => (id ? (agents.find((a) => a.id === id)?.name ?? t('已删除的角色')) : t('没选角色'))
  return (
    <div className="flex flex-col gap-4" data-flow-overview>
      <FlowStatTiles s={s} />
      <Card as="section" aria-label={t('按角色')} className="py-1.5" data-flow-roles>
        <header className="flex min-w-0 items-center gap-2.5 px-4 pt-2 pb-1.5">
          <h2 className="text-body font-medium text-fg">{t('按角色')}</h2>
          <span className="rounded-full bg-sel px-1.5 text-caption text-muted tabular-nums">{s.roles.length}</span>
          <span className="hidden min-w-0 truncate text-xs text-subtle sm:block">
            {t('返工（评审退回 + 合回失败）多的排在前面')}
          </span>
        </header>
        <div role="table" className="flex flex-col px-1.5 pb-1">
          <div role="row" className={cn(ROLE_GRID, 'px-2.5 py-1 text-caption whitespace-nowrap text-subtle')}>
            <span role="columnheader">{t('角色')}</span>
            <span role="columnheader" className="text-right">
              {t('对话')}
            </span>
            <span role="columnheader" className="text-right">
              {t('推进')}
            </span>
            <span role="columnheader" className="text-right">
              {t('退回')}
            </span>
            <span role="columnheader" className="text-right">
              {t('合回失败')}
            </span>
            <span role="columnheader" className="text-right max-sm:hidden">
              {t('等你')}
            </span>
            <span role="columnheader" className="text-right max-sm:hidden">
              Token
            </span>
          </div>
          {s.roles.map((r) => (
            <div
              role="row"
              key={r.agentId || '-'}
              data-flow-role={r.agentId}
              className={cn(ROLE_GRID, 'rounded-lg px-2.5 py-1.5 text-body tabular-nums hover:bg-sel/60')}
            >
              <span role="cell" className="truncate text-fg">
                {roleName(r.agentId)}
              </span>
              <span role="cell" className="text-right text-muted">
                {r.convs}
              </span>
              <span role="cell" className="text-right text-muted">
                {r.drives}
              </span>
              <span role="cell" className={cn('text-right', r.reviewRejects ? 'text-warning' : 'text-subtle')}>
                {r.reviewRejects}
              </span>
              <span role="cell" className={cn('text-right', r.mergeFails ? 'text-danger' : 'text-subtle')}>
                {r.mergeFails}
              </span>
              <span role="cell" className="text-right text-muted max-sm:hidden">
                {r.waitMs ? stayText(r.waitMs) : '—'}
              </span>
              <span role="cell" className="text-right font-mono text-xs text-subtle max-sm:hidden">
                {r.tokens ? fmtTokens(r.tokens) : '—'}
              </span>
            </div>
          ))}
        </div>
      </Card>
      {hot.length > 0 && (
        <Card as="section" aria-label={t('推得多、返工多的对话')} className="py-1.5" data-flow-hot>
          <header className="flex min-w-0 items-center gap-2.5 px-4 pt-2 pb-1.5">
            <h2 className="text-body font-medium text-fg">{t('推得多、返工多的对话')}</h2>
            <span className="hidden min-w-0 truncate text-xs text-subtle sm:block">
              {t('改角色、提示词之前先看这些对话卡在哪')}
            </span>
          </header>
          <ul className="flex flex-col gap-0.5 px-1.5">
            {hot.map((b) => (
              <HotRow key={b.id} b={b} project={projectName(b.projectId)} onOpen={() => onOpen(b)} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/** 角色表的列：名字占剩下的宽度，数字列定宽右对齐；手机上收掉「等你」和 token 两列、数字列收窄，给名字留出位置 */
const ROLE_GRID =
  'grid items-center gap-x-2 grid-cols-[minmax(0,1fr)_repeat(4,2.75rem)] sm:gap-x-3 sm:grid-cols-[minmax(0,1fr)_repeat(4,3.5rem)_5rem_4.5rem]'

/** 顶上一排数字，下面一行写交代结束和 token 的合计 */
function FlowStatTiles({ s }: { s: FlowSummary }) {
  return (
    <div className="flex flex-col gap-2" data-flow-stats>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile
          data-flow-stat="total"
          icon={Layers}
          tile="bg-accent-soft text-accent-text"
          label={t('对话')}
          value={String(s.total)}
          dim={!s.total}
          note={t('顶层 {tops} · 子对话 {children}', { tops: s.tops, children: s.children })}
        />
        <StatTile
          data-flow-stat="drives"
          icon={Repeat}
          tile="bg-run-soft text-run"
          label={t('平均推进次数')}
          value={num(s.avgDrives)}
          dim={!s.drives}
          note={t('面板推它「接着做」的次数，一共 {n} 次', { n: s.drives })}
          short={t('一共 {n} 次', { n: s.drives })}
        />
        <StatTile
          data-flow-stat="rejects"
          icon={Undo2}
          tile="bg-warning/12 text-warning"
          label={t('评审退回')}
          value={String(s.reviewRejects)}
          dim={!s.reviewRejects}
          note={t('{n} 个对话被退回过：节点验收不通过重做，或派出的评审、测试给了不通过', { n: s.rejectedConvs })}
          short={t('{n} 个对话被退回过', { n: s.rejectedConvs })}
        />
        <StatTile
          data-flow-stat="merge"
          icon={GitMerge}
          tile="bg-success/12 text-success"
          label={t('一次合回')}
          value={pct(s.mergeFirstRate)}
          dim={s.mergeFirstRate === undefined}
          note={t('合回了 {merged} 个子对话，没能合回被退回 {fails} 次', {
            merged: s.mergedKids,
            fails: s.mergeFails,
          })}
          short={s.mergedKids ? t('合回失败 {n} 次', { n: s.mergeFails }) : t('还没有合回的子对话')}
        />
        <StatTile
          data-flow-stat="wait"
          icon={Hourglass}
          tile="bg-sel text-muted"
          label={t('平均等你')}
          value={s.avgWaitMs === undefined ? '—' : stayText(s.avgWaitMs)}
          dim={s.avgWaitMs === undefined}
          note={t('{n} 个对话等过你确认或回答，只按它们平均', { n: s.waitedConvs })}
          short={t('{n} 个对话等过你', { n: s.waitedConvs })}
          className="max-md:col-span-2"
        />
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-xs text-subtle" data-flow-totals>
        <Workflow className="h-3.5 w-3.5" />
        <span>
          {t('一共 {turns} 轮，交代结束：做完 {done} · 卡住 {blocked}', {
            turns: s.turns,
            done: s.endDone,
            blocked: s.endBlocked,
          })}
          {s.blockedRate !== undefined && t('（卡住占 {p}）', { p: pct(s.blockedRate) })}
        </span>
        <span>·</span>
        <span className="font-mono tabular-nums">
          {t('Token {tokens}，平均每个对话 {avg}', {
            tokens: fmtTokens(s.tokens),
            avg: s.avgTokens === undefined ? '—' : fmtTokens(Math.round(s.avgTokens)),
          })}
          {s.costUsd > 0 && ` · $${s.costUsd.toFixed(2)}`}
        </span>
      </p>
    </div>
  )
}

function HotRow({ b, project, onOpen }: { b: FlowBrief; project: string; onOpen: () => void }) {
  const facts = [
    b.drives ? t('推了 {n} 次', { n: b.drives }) : '',
    b.reviewRejects ? t('退回 {n} 次', { n: b.reviewRejects }) : '',
    b.mergeFails ? t('合回失败 {n} 次', { n: b.mergeFails }) : '',
    b.waitMs ? t('等你 {time}', { time: stayText(b.waitMs) }) : '',
  ].filter(Boolean)
  const rework = flowReworks(b) > 0
  return (
    <li data-flow-row={b.id}>
      {/* 整行一个按钮：点哪都是打开那个对话 */}
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors outline-none hover:bg-sel/60 focus-visible:ring-[3px] focus-visible:ring-focus-soft"
      >
        {/* 返工过的用退回的图标、画成警示色；只是推得多的用推进的图标 */}
        <span
          aria-hidden
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
            rework ? 'bg-warning/12 text-warning' : 'bg-sel text-muted',
          )}
        >
          {rework ? <Undo2 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-prose text-fg">{b.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="shrink-0 truncate">{project}</span>
            {b.parentTaskId && (
              <>
                <span className="text-subtle">·</span>
                <span className="shrink-0">{t('子对话')}</span>
              </>
            )}
            <span className="text-subtle">·</span>
            <span className="truncate">{facts.join(' · ')}</span>
          </span>
        </span>
      </button>
    </li>
  )
}
