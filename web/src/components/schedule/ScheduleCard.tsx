import { useState } from 'react'
import { ChevronDown, ExternalLink, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react'
import {
  groupOf,
  nextRunLabel,
  outcomeLabel,
  outcomeOf,
  outcomeTitle,
  repeatLabel,
  runLabel,
  scheduleEnded,
  whenLabel,
  type Schedule,
  type ScheduleGroup,
} from '@shared/schedule'
import { t } from '@shared/i18n'
import { timeAgo } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { Switch } from '@/components/ui/switch'

/** 启动失败的原文超过这个长度才给「展开全文」：窄屏一行大约只放得下这么多字，再长会被截掉 */
const ERROR_PREVIEW_CHARS = 30

/** 标题前的圆点按分组取色：一眼看出这张卡片现在是什么状态（不用左侧色条，卡片不描边） */
const GROUP_TONE: Record<ScheduleGroup, string> = {
  upcoming: 'bg-accent',
  problem: 'bg-warning',
  disabled: 'bg-line-strong',
  finished: 'bg-line',
}

/** 最近一次结果的色调：问题和错过都要能一眼看见，成功不抢眼 */
const OUTCOME_TONE = {
  error: 'warning',
  missed: 'warning',
  blocked: 'warning',
  success: 'success',
  none: 'neutral',
} as const

/** 执行上限的一句话；两项都没设时返回空字符串，不占位置 */
function budgetLabel(s: Schedule): string {
  if (!s.budget.tokens && !s.budget.minutes) return ''
  return [
    s.budget.tokens > 0 ? t('{n} token', { n: s.budget.tokens.toLocaleString() }) : '',
    s.budget.minutes > 0 ? t('{n} 分钟', { n: s.budget.minutes }) : '',
  ]
    .filter(Boolean)
    .join(t('、'))
}

/**
 * 一张计划卡片：名称与重复规则 → 下次执行 → 项目 / 角色 → 最近一次结果 → 运行记录。
 * 启停用开关，编辑和删除收在更多菜单里；「立即执行」是显式按钮，用户最常点的操作不藏。
 */
export function ScheduleCard({
  schedule: s,
  now,
  projectName,
  agentName,
  upstreams,
  busy,
  taskTitle,
  onEdit,
  onRun,
  onToggle,
  onDelete,
  onOpenTask,
}: {
  schedule: Schedule
  now: number
  projectName: string
  agentName: string
  /** 上游计划的名字；找不到的是已经被删掉的，用占位名字 */
  upstreams: string[]
  busy: boolean
  /** 对话标题：历史里显示「打开哪一次」；对话被删掉时为空 */
  taskTitle: (taskId: string) => string
  onEdit: () => void
  onRun: () => void
  onToggle: (on: boolean) => void
  onDelete: () => void
  onOpenTask: (taskId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [runsOpen, setRunsOpen] = useState(false)
  const outcome = outcomeOf(s)
  const next = nextRunLabel(s, now)
  const budget = budgetLabel(s)
  // 实际渲染的文本（错过 / 成功时带「上次启动失败：」前缀）：阈值按它算，
  // 否则前缀会把一行挤满却不出现「展开全文」，触屏上没有 title 可看
  const errorText = outcome === 'error' ? s.lastError : t('上次启动失败：{error}', { error: s.lastError })
  // 失败原文可能很长（带堆栈、带换行）：先显示一行，要看全文再展开
  const longError = errorText.length > ERROR_PREVIEW_CHARS || s.lastError.includes('\n')

  return (
    <li className="relative overflow-hidden rounded-xl bg-card shadow-card">
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', GROUP_TONE[groupOf(s)])} />
              <h3 className={cn('min-w-0 truncate text-[0.9375rem] font-semibold', !s.enabled && 'text-muted')}>
                {s.name}
              </h3>
              <Badge>{repeatLabel(s.repeat)}</Badge>
              {!!s.endDate && s.repeat !== 'once' && <Badge>{t('到 {date} 结束', { date: s.endDate })}</Badge>}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span>{projectName || t('聊天')}</span>
              <span className="text-subtle">·</span>
              <span>{agentName || t('跟随默认 CLI')}</span>
              {!!budget && (
                <>
                  <span className="text-subtle">·</span>
                  <span>{budget}</span>
                </>
              )}
            </p>
            {/* 上游依赖：这几条计划这一轮成功启动之后本计划才会启动；名字都找不到说明上游被删了 */}
            {!!upstreams.length && (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span className="text-subtle">{t('上游')}</span>
                <span>{upstreams.join(t('、'))}</span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Switch
              checked={s.enabled}
              onCheckedChange={onToggle}
              aria-label={s.enabled ? t('停用') : t('启用')}
              title={s.enabled ? t('停用') : t('启用')}
            />
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRun}>
              <Play className="h-3.5 w-3.5" />
              {t('立即执行')}
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('计划操作')} title={t('计划操作')}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={onEdit}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('编辑')}
                </MenuItem>
                <MenuItem danger onSelect={onDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('删除')}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>

        {/* 下次执行：相对时间 + 绝对时间都在这一行；停用 / 单次跑完后只写不会再有下一次，不再加「下次执行」标签 */}
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {next ? (
            <>
              <span className="text-xs text-subtle">{t('下次执行')}</span>
              <span className={cn('text-base font-medium tabular-nums', s.enabled ? 'text-fg' : 'text-subtle')}>
                {next}
              </span>
            </>
          ) : (
            <span className="text-[0.9375rem] font-medium text-subtle">
              {/* 过了结束日期是用户定好的到此为止，和单次跑完、停用分开说 */}
              {s.enabled && scheduleEnded(s) ? t('已结束（{date}）', { date: s.endDate }) : t('不会再次执行')}
            </span>
          )}
        </p>

        {/* 最近一次结果：成功 / 错过 / 未启动 / 启动失败各说清发生了什么，原因不吞 */}
        <div className="flex flex-col gap-1.5 border-t pt-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={OUTCOME_TONE[outcome]}>{outcomeTitle(s)}</Badge>
            {/* 徽标已经说了结果，正文只补细节；原因类型的在下面单独一段用警告色显示 */}
            {(outcome === 'missed' || outcome === 'success') && (
              <span className="text-muted">{outcomeLabel(s, now)}</span>
            )}
            {outcome === 'success' && <span className="text-subtle">{timeAgo(s.lastRunAt, now)}</span>}
            {!!s.lastTaskId && (
              <button
                type="button"
                onClick={() => onOpenTask(s.lastTaskId)}
                className="inline-flex cursor-pointer items-center gap-1 text-accent hover:underline"
              >
                {t('打开这次执行')}
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
          {!!s.lastError && (
            <div className="flex flex-col gap-1">
              <p
                className={cn('break-words whitespace-pre-wrap text-warning', !expanded && 'line-clamp-1')}
                title={expanded ? undefined : s.lastError}
              >
                {errorText}
              </p>
              {longError && (
                <button
                  type="button"
                  className="w-fit cursor-pointer text-subtle hover:text-fg"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? t('收起') : t('展开全文')}
                </button>
              )}
            </div>
          )}
          {/* 上游没成功：写清是哪个上游、什么结果，不静默跳过 */}
          {outcome === 'blocked' && (
            <p className="break-words whitespace-pre-wrap text-warning">
              {s.blockedReason || t('上游没有成功，没有启动')}
            </p>
          )}
          {/* 最近一次 Webhook 投递：没开 Webhook 时没有这条记录，不占位置 */}
          {!!s.lastDelivery && (
            <p className={cn('break-words', s.lastDelivery.ok ? 'text-subtle' : 'text-warning')}>
              {s.lastDelivery.ok
                ? t('Webhook 已投递于 {time}', { time: whenLabel(s.lastDelivery.at, now) })
                : t('Webhook 投递失败：{error}', { error: s.lastDelivery.error })}
            </p>
          )}
          {/* 运行记录：默认收起，展开看最近几次；更早的到对应的对话里看 */}
          {!!s.runs.length && (
            <div className="flex flex-col gap-1.5 pt-0.5">
              <button
                type="button"
                aria-expanded={runsOpen}
                onClick={() => setRunsOpen((v) => !v)}
                className="flex w-fit cursor-pointer items-center gap-1 text-subtle hover:text-fg"
              >
                <ChevronDown className={cn('h-3 w-3 transition-transform', runsOpen && 'rotate-180')} />
                {t('运行记录')}
                <span className="tabular-nums">{s.runs.length}</span>
              </button>
              {runsOpen && (
                <ul className="flex flex-col gap-1.5 border-l pl-2.5">
                  {s.runs.map((run, i) => (
                    <li key={`${run.happenedAt}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className={run.event === 'run' ? 'text-success' : 'text-warning'}>{runLabel(run)}</span>
                      {run.manual && <span className="text-subtle">{t('手动执行')}</span>}
                      <span className="text-subtle tabular-nums">{whenLabel(run.at || run.happenedAt, now)}</span>
                      {!!run.taskId && (
                        <button
                          type="button"
                          onClick={() => onOpenTask(run.taskId)}
                          className="inline-flex min-w-0 max-w-[220px] cursor-pointer items-center gap-1 text-accent hover:underline"
                        >
                          <span className="truncate">{taskTitle(run.taskId) || t('打开对话')}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </button>
                      )}
                      {/* 错过没有可存的原因（面板当时没在跑），在界面补一句：
                          否则最近一次结果变成「已启动」之后，这条错过就只剩时间、看不出为什么没跑 */}
                      {run.error ? (
                        <span className="basis-full break-words whitespace-pre-wrap text-warning">{run.error}</span>
                      ) : run.event === 'miss' ? (
                        <span className="basis-full text-subtle">{t('面板当时没在跑，不补跑')}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
