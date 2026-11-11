import { useMemo } from 'react'
import { Bug, Check, Gauge, ListChecks, MessagesSquare, Target } from 'lucide-react'
import { RATING_TEXT } from '@shared/bug-diagnosis-card'
import {
  BUG_GROUPS,
  bugLevelText,
  bugPhaseText,
  bugRows,
  bugWhoText,
  type BugBrief,
  type BugGroup,
  type BugRow,
} from '@shared/bug-overview'
import { BUG_PHASES, bugStats, type BugSummary, type BugTier } from '@shared/bug-stats'
import { t } from '@shared/i18n'
import { timeAgo } from '@shared/task'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { StatTile } from '@/components/ui/stat-tile'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'

const GROUP_LABEL: Record<BugGroup, string> = {
  you: t('等你处理'),
  active: t('进行中'),
  ended: t('已结束'),
}

/** 每组一句话说明它为什么在这一组，规则和 shared/bug-overview.ts 的 bugWho 一致 */
const GROUP_HINT: Record<BugGroup, string> = {
  you: t('报告等你确认、等你复现或验证，它问了问题，或者观察期里又出现了'),
  active: t('它在分析或在修，偶发的修好后在这里观察几天，暂时不用你管'),
  ended: t('已经修好，或者你点了不修了'),
}

/** 已结束那一组只列这么多：视图是看「现在卡在哪」的，更早的在各自的父对话里 */
const ENDED_MAX = 30

/** 根因等级的颜色：和诊断报告决策卡（DiagnosisCard）同一套，低级是粗心所以最扎眼 */
const TIER_CHIP: Record<BugTier, string> = {
  low: 'bg-danger/12 text-danger',
  mid: 'bg-warning/15 text-warning',
  high: 'bg-accent/12 text-accent',
}

const TIERS: BugTier[] = ['low', 'mid', 'high']

/** 观察期到哪天：只写月-日，行上放得下 */
const dayText = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}

/** 时长写成一个单位的整数：这里只要量级（等了几分钟还是几天），不用 4m 3.6s 那种精度 */
export function stayText(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return t('不到 1 分钟')
  if (s < 3600) return t('{n} 分钟', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小时', { n: Math.floor(s / 3600) })
  return t('{n} 天', { n: Math.floor(s / 86400) })
}

/** 平均值最多一位小数，整数不带 .0；没有样本画成「—」 */
const num = (v: number | undefined) => (v === undefined ? '—' : String(Math.round(v * 10) / 10))

/**
 * 总览页的 Bug 视图（分析稿 B6、B7）：顶上一排流程数据，下面按「等你处理 / 进行中 / 已结束」分组列出所有用户报的 Bug。
 * 数据由页面取好传进来（GET /tasks/bugs），这里只管画；点一行交给页面打开那个对话
 */
export function BugOverview({
  briefs,
  query,
  now,
  projectName,
  onOpen,
}: {
  /** 还没取到是 undefined：先不画空态，免得闪一下「还没有 Bug」 */
  briefs: BugBrief[] | undefined
  /** 页头搜索框里的字：搜标题、项目名、父对话标题 */
  query: string
  /** 算「停了多久」的当前时间：由页面跟着刷新给，不在渲染里读时钟 */
  now: number
  projectName: (id: string) => string
  onOpen: (b: BugBrief) => void
}) {
  const stats = useMemo(() => bugStats(briefs ?? []).summary, [briefs])
  const rows = useMemo(() => bugRows(briefs ?? []), [briefs])
  if (!briefs) return null
  const q = query.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      !q ||
      r.bug.title.toLowerCase().includes(q) ||
      r.bug.parentTitle.toLowerCase().includes(q) ||
      projectName(r.bug.projectId).toLowerCase().includes(q),
  )
  return (
    <>
      <BugStatCards s={stats} />
      {!shown.length ? (
        <EmptyPanel size="xl">
          {q ? t('没有符合的 Bug') : t('还没有用户报的 Bug。在对话里发 /bug 描述问题，它会按流程排查，进度列在这里。')}
        </EmptyPanel>
      ) : (
        <div className="flex flex-col gap-4" data-bug-overview>
          {BUG_GROUPS.map((g) => {
            const list = shown.filter((r) => r.group === g)
            if (!list.length) return null
            const cut = g === 'ended' ? list.slice(0, ENDED_MAX) : list
            return (
              <Card as="section" key={g} aria-label={GROUP_LABEL[g]} data-bug-group={g} className="py-1.5">
                <header className="flex min-w-0 items-center gap-2.5 px-4 pt-2 pb-1.5">
                  <h2 className="text-body font-medium text-fg">{GROUP_LABEL[g]}</h2>
                  <span className="rounded-full bg-sel px-1.5 text-caption text-muted tabular-nums">{list.length}</span>
                  <span className="hidden min-w-0 truncate text-xs text-subtle sm:block">{GROUP_HINT[g]}</span>
                </header>
                <ul className="flex flex-col gap-0.5 px-1.5">
                  {cut.map((r) => (
                    <Row
                      key={r.bug.id}
                      r={r}
                      now={now}
                      project={projectName(r.bug.projectId)}
                      onOpen={() => onOpen(r.bug)}
                    />
                  ))}
                </ul>
                {list.length > cut.length && (
                  <p className="px-4 pt-1.5 pb-1 text-xs text-subtle">
                    {t('还有 {n} 个更早结束的 Bug，在各自的父对话里找', { n: list.length - cut.length })}
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}

/** 顶上的流程数据：统计卡片（StatTile）和对话视图的四张分组卡片样式一样，但只是数字，不能点 */
function BugStatCards({ s }: { s: BugSummary }) {
  const tiers = RATING_TEXT()
  const stays = BUG_PHASES.flatMap((p) =>
    s.avgPhaseMs[p] === undefined ? [] : [`${bugPhaseText(p)} ${stayText(s.avgPhaseMs[p])}`],
  )
  return (
    <div className="flex flex-col gap-2" data-bug-stats>
      {/* 最后一张要并排放三个等级，比前四张宽一点 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.3fr)]">
        <StatTile
          data-bug-stat="total"
          icon={Bug}
          tile="bg-accent-soft text-accent-text"
          label={t('Bug 总数')}
          value={String(s.total)}
          dim={!s.total}
          note={t('在查 {open} · 修好 {fixed} · 不修 {cancelled}', {
            open: s.open,
            fixed: s.fixed,
            cancelled: s.cancelled,
          })}
          short={t('在查 {open} · 修好 {fixed}', { open: s.open, fixed: s.fixed })}
        />
        <StatTile
          data-bug-stat="first-try"
          icon={Target}
          tile="bg-success/12 text-success"
          label={t('一次修好')}
          value={s.firstTryRate === undefined ? '—' : `${Math.round(s.firstTryRate * 100)}%`}
          dim={s.firstTryRate === undefined}
          note={
            s.fixed
              ? t('修好的 {fixed} 个里有 {n} 个', { fixed: s.fixed, n: s.firstTry })
              : t('没被否决、验证一次过、没回到论证')
          }
          short={s.fixed ? undefined : t('还没有修好的')}
        />
        <StatTile
          data-bug-stat="decisions"
          icon={ListChecks}
          tile="bg-warning/12 text-warning"
          label={t('平均确认次数')}
          value={num(s.avgDecisions)}
          dim={s.avgDecisions === undefined}
          note={t('每个 Bug 要你经手几次')}
          short={t('每个 Bug 经手几次')}
        />
        <StatTile
          data-bug-stat="rounds"
          icon={MessagesSquare}
          tile="bg-run-soft text-run"
          label={t('平均论证轮数')}
          value={num(s.avgEvidenceRounds)}
          dim={s.avgEvidenceRounds === undefined}
          note={t('加日志、复现、分析算一轮')}
          short={t('每个 Bug 论证几轮')}
        />
        {/* 手机上两列排四张，这一张单独占满一行，三个等级才排得开 */}
        <Card className="flex items-center gap-3 px-4 py-3 max-md:col-span-2" data-bug-stat="tiers">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sel text-muted">
            <Gauge className="h-[18px] w-[18px]" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-xs text-muted">{t('根因等级')}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {TIERS.map((x) => (
                <span key={x} className="flex items-center gap-1" title={`${tiers[x].label}：${tiers[x].hint}`}>
                  <span className={cn('rounded-md px-1.5 text-caption leading-5 font-medium', TIER_CHIP[x])}>
                    {tiers[x].label}
                  </span>
                  <span className={cn('text-body font-semibold tabular-nums', s.tiers[x] ? 'text-fg' : 'text-subtle')}>
                    {s.tiers[x]}
                  </span>
                </span>
              ))}
            </span>
          </span>
        </Card>
      </div>
      {(stays.length > 0 || s.avgTotalMs !== undefined) && (
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 px-1 text-xs text-subtle" data-bug-stays>
          {stays.length > 0 && (
            <span>
              {t('各步平均停留：')}
              {stays.join(' · ')}
            </span>
          )}
          {s.avgTotalMs !== undefined && <span>{t('从立案到结束平均 {time}', { time: stayText(s.avgTotalMs) })}</span>}
        </p>
      )}
    </div>
  )
}

const WHO_TONE: Record<BugRow['who'], StatusTone> = {
  confirm: 'wait',
  repro: 'wait',
  verify: 'wait',
  reply: 'wait',
  failed: 'err',
  analyzing: 'run',
  cleaning: 'run',
  idle: 'idle',
  fixed: 'ok',
  cancelled: 'idle',
  observing: 'run',
  relapsed: 'err',
}

function Row({ r, now, project, onOpen }: { r: BugRow; now: number; project: string; onOpen: () => void }) {
  const { bug, who, rating } = r
  const tiers = RATING_TEXT()
  const stay = stayText(now - new Date(r.since).getTime())
  // 已结束的写什么时候结束的；还开着的写在这一步停了多久，等你的那几种直接写「等了」
  // 观察中的写观察到哪天（分析稿 B13）；又出现了的写又报了几次
  const since =
    who === 'observing' && bug.observeUntil
      ? t('观察到 {date}', { date: dayText(bug.observeUntil) })
      : who === 'relapsed'
        ? t('又报了 {n} 次', { n: bug.relapses ?? 1 })
        : r.group === 'ended'
          ? timeAgo(r.since, now)
          : r.group === 'you'
            ? t('等了 {time}', { time: stay })
            : t('这一步 {time}', { time: stay })
  return (
    <li data-bug-row={bug.id} data-bug-who={who}>
      {/* 整行一个按钮：这里没有勾选，点哪都是打开那个对话 */}
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors outline-none hover:bg-sel/60 focus-visible:ring-[3px] focus-visible:ring-focus-soft"
      >
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sel text-muted">
          <Bug className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-prose text-fg">{bug.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="shrink-0 truncate">{project}</span>
            {bug.parentTitle && (
              <>
                <span className="text-subtle">·</span>
                <span className="min-w-0 truncate">{bug.parentTitle}</span>
              </>
            )}
          </span>
          {/* 窄屏放不下右边那几列：五步进度挪到标题下面，时间跟在后面 */}
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 md:hidden">
            <span className="shrink-0">
              <BugSteps r={r} />
            </span>
            <span className="truncate text-caption text-subtle tabular-nums">{since}</span>
          </span>
        </span>
        <span className="hidden w-48 shrink-0 md:block">
          <BugSteps r={r} />
        </span>
        <span className="hidden w-10 shrink-0 text-xs text-muted lg:block" title={t('排查级别')}>
          {bugLevelText(bug.level)}
        </span>
        <span className="hidden w-[5.5rem] shrink-0 items-center gap-1.5 lg:flex">
          {rating && (
            <>
              <span
                className={cn('rounded-md px-1.5 text-caption leading-5 font-medium', TIER_CHIP[rating.tier])}
                title={t('根因等级：{label}（{hint}）', tiers[rating.tier])}
              >
                {tiers[rating.tier].label}
              </span>
              <span className="text-xs text-muted tabular-nums" title={t('对根因的把握')}>
                {rating.percent}%
              </span>
            </>
          )}
        </span>
        <span className="hidden w-24 shrink-0 truncate text-right text-xs text-subtle tabular-nums md:block">
          {since}
        </span>
        <span className="flex w-28 shrink-0 justify-end max-sm:w-auto">
          <StatusPill tone={WHO_TONE[who]} spin={who === 'analyzing' || who === 'cleaning'}>
            {bugWhoText(who)}
          </StatusPill>
        </span>
      </button>
    </li>
  )
}

/**
 * 五步进度：论证 / 根因 / 修复方案 / 修复 / 验证画成五个小点，做完的打勾、当前的高亮，后面跟当前那一步的名字。
 * 已取消的停在哪一步照样看得出，但那一步不再高亮（没人在做了）
 */
function BugSteps({ r }: { r: BugRow }) {
  const live = r.group !== 'ended'
  const at = BUG_PHASES[r.step]
  const name = !at ? '' : at === 'evidence' && r.rounds > 1 ? t('论证 · 第 {n} 轮', { n: r.rounds }) : bugPhaseText(at)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        role="img"
        aria-label={at ? t('五步进度：现在在{phase}', { phase: bugPhaseText(at) }) : t('五步进度：五步都走完了')}
        className="flex shrink-0 items-center"
        data-bug-steps={r.step}
      >
        {BUG_PHASES.map((p, i) => (
          <span key={p} className="flex items-center" title={bugPhaseText(p)}>
            {i > 0 && <span className={cn('h-px w-1.5', i <= r.step ? 'bg-success/50' : 'bg-line')} />}
            <span
              data-step={i < r.step ? 'done' : i === r.step ? 'current' : 'todo'}
              className={cn(
                'grid h-3.5 w-3.5 place-items-center rounded-full',
                i < r.step
                  ? 'bg-success/15 text-success'
                  : i === r.step
                    ? live
                      ? 'bg-accent ring-2 ring-accent/25'
                      : 'bg-subtle/50'
                    : 'border border-line-strong',
              )}
            >
              {i < r.step && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
            </span>
          </span>
        ))}
      </span>
      {name && <span className={cn('truncate text-caption', live ? 'text-muted' : 'text-subtle')}>{name}</span>}
    </span>
  )
}
