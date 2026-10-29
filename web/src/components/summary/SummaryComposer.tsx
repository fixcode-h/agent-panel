/**
 * 提炼面板（右边「新建」时显示）：从上到下是来源（报告 / 对话）、时间（按天 / 按周 + 月历）、
 * 来源对应的材料（对话：面板里加过的项目；报告：这段时间已经生成的报告）、用哪个角色提炼，
 * 提炼完逐项采纳，底部确认后只用采纳的分项生成报告。
 * 状态都由页面管（见 SummaryPage）：这里只负责摆放和把操作交回去。
 */
import { AlertTriangle, Loader2, RotateCcw, Sparkles, Square, Wand2 } from 'lucide-react'
import {
  reportName,
  SUMMARY_GRAINS,
  windowLabel,
  type SummaryGrain,
  type SummaryJob,
  type SummaryRecord,
  type SummarySource,
  type SummaryWindow,
} from '@shared/summary'
import { t } from '@shared/i18n'
import { dayKey } from '@shared/usage'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Segmented } from '@/components/ui/segmented'
import { CliTag } from '@/components/library/parts'
import { PeriodPicker } from '@/components/usage/PeriodPicker'
import { ProjectShelf } from './ProjectShelf'
import { ConfirmBar, EntryList } from './EntryList'

const GRAIN_LABEL: Record<SummaryGrain, () => string> = { day: () => t('按天'), week: () => t('按周') }

/** 一行设置：左边是固定宽度的名字，右边是控件；窄屏时上下排 */
function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line px-5 py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <span className="w-14 shrink-0 pt-1.5 text-[0.8125rem] font-medium text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {children}
        {hint && <p className="text-xs leading-relaxed text-subtle">{hint}</p>}
      </div>
    </div>
  )
}

export function SummaryComposer({
  source,
  onSource,
  grain,
  onGrain,
  win,
  onDay,
  onToday,
  marked,
  minDay,
  projects,
  projectIds,
  projectCounts,
  onProjects,
  sourceReports,
  onOpenReport,
  role,
  job,
  error,
  adopted,
  onToggle,
  onAdoptAll,
  onExtract,
  onStop,
  onConfirm,
  confirming,
}: {
  source: SummarySource
  onSource: (s: SummarySource) => void
  grain: SummaryGrain
  onGrain: (g: SummaryGrain) => void
  /** 当前选中的时间窗口 */
  win: SummaryWindow
  onDay: (d: Date) => void
  onToday: () => void
  /** 月历上带圆点的日子：这些天有对话（或报告） */
  marked: Set<string>
  minDay: Date
  projects: { id: string; name: string }[]
  projectIds: string[]
  projectCounts: Map<string, number>
  onProjects: (ids: string[]) => void
  /** 来源是「报告」时这段时间能用的报告 */
  sourceReports: SummaryRecord[]
  onOpenReport: (id: string) => void
  /** 生成用的角色：名字、CLI、模型；没装能用的 CLI 时为空 */
  role: { name: string; cli: string; cliName: string; model: string; onOpen?: () => void } | null
  job: SummaryJob | null
  error: string
  adopted: Set<string>
  onToggle: (id: string) => void
  onAdoptAll: (ids: string[], on: boolean) => void
  onExtract: () => void
  onStop: () => void
  onConfirm: () => void
  confirming: boolean
}) {
  const running = job?.status === 'running'
  const today = new Date()
  const onCurrent = win.fromDay <= dayKey(today) && dayKey(today) <= win.toDay
  const ready = source === 'tasks' ? projectIds.length > 0 : sourceReports.length > 0
  const lastThought = job?.thinking?.trim().split('\n').filter(Boolean).at(-1)
  const done = job?.status === 'done'

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto" aria-label={t('提炼工作总结')}>
      <div className="flex w-full max-w-[920px] flex-col gap-5 px-4 pt-6 pb-10 md:px-8 md:pt-8">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{t('提炼工作总结')}</h2>
            <p className="mt-1 max-w-[620px] text-[0.8125rem] leading-relaxed text-muted">
              {t(
                '选来源和日期，先提炼出一条条需求和 Bug，挑出要写进报告的点「采纳」，确认后才生成报告。只分析所选日期内的内容。',
              )}
            </p>
          </div>
        </header>

        <Card as="section" aria-label={t('提炼设置')}>
          <Row
            label={t('来源')}
            hint={
              source === 'reports'
                ? t('从这段时间已经生成的报告里汇总，适合把几份日报合成周报。')
                : t('从下面这些项目在这段时间执行过的对话里提炼。')
            }
          >
            <Segmented
              label={t('报告来源')}
              value={source}
              onChange={onSource}
              options={[
                { id: 'reports', label: t('报告') },
                { id: 'tasks', label: t('对话') },
              ]}
              className="self-start"
            />
          </Row>
          <Row label={t('日期')}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label={t('报告粒度')}
                value={grain}
                onChange={onGrain}
                options={SUMMARY_GRAINS.map((g) => ({ id: g, label: GRAIN_LABEL[g]() }))}
              />
              <PeriodPicker
                grain={grain}
                start={new Date(win.start)}
                marked={marked}
                min={minDay}
                max={today}
                onChange={onDay}
                label={windowLabel(grain, win.fromDay)}
                hint={grain === 'day' ? t('点一天总结那一天') : t('点一天总结那一周')}
              />
              {!onCurrent && (
                <Button variant="ghost" size="sm" onClick={onToday}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {grain === 'day' ? t('回到今天') : t('回到本周')}
                </Button>
              )}
            </div>
          </Row>
          {source === 'tasks' ? (
            <Row
              label={t('项目')}
              hint={
                projectIds.length
                  ? t('加过的项目会留在这里，下次直接用；数字是这段时间执行过的对话数。')
                  : t('先添加要总结的项目，加过的项目会留在这里，下次直接用。')
              }
            >
              <ProjectShelf
                projects={projects}
                ids={projectIds}
                counts={projectCounts}
                disabled={running}
                onChange={onProjects}
              />
            </Row>
          ) : (
            <Row
              label={t('报告')}
              hint={
                sourceReports.length
                  ? t('只用覆盖范围在这段时间之内的报告。')
                  : t('这段时间还没有生成过报告，可以切到「对话」来源先生成日报。')
              }
            >
              {sourceReports.length ? (
                <ul className="flex flex-wrap gap-1.5" aria-label={t('要汇总的报告')}>
                  {sourceReports.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => onOpenReport(r.id)}
                        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-[0.8125rem] hover:border-line-strong"
                      >
                        <span className="text-subtle tabular-nums">{(r.from || r.day).slice(5)}</span>
                        <span className="max-w-[200px] truncate">{reportName(r)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="pt-1.5 text-[0.8125rem] text-subtle">{t('没有可用的报告')}</span>
              )}
            </Row>
          )}
          <div className="flex flex-wrap items-center gap-2 bg-sel/25 px-5 py-3">
            {role ? (
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-subtle">
                <Wand2 className="h-3.5 w-3.5" />
                {t('提炼角色')}
                {role.onOpen ? (
                  <button
                    type="button"
                    onClick={role.onOpen}
                    className="cursor-pointer font-medium text-fg underline-offset-2 hover:underline"
                    title={t('打开角色，调整提炼规则和模型')}
                  >
                    {role.name}
                  </button>
                ) : (
                  <span className="font-medium text-fg">{role.name}</span>
                )}
                <CliTag id={role.cli} name={role.cliName} />
                {!!role.model && <span className="font-mono">{role.model}</span>}
              </span>
            ) : (
              <span className="text-xs text-warning">{t('没有可用的 Agent，请先在设置里安装并启用')}</span>
            )}
            <div className="ml-auto">
              {running ? (
                <Button size="sm" variant="secondary" onClick={onStop}>
                  <Square className="h-3.5 w-3.5" />
                  {t('停止')}
                </Button>
              ) : (
                <Button size="sm" disabled={!ready || !role} onClick={onExtract}>
                  <Sparkles className="h-3.5 w-3.5" />
                  {job?.status === 'failed' ? t('重试') : done ? t('重新提炼') : t('开始提炼')}
                </Button>
              )}
            </div>
          </div>
        </Card>

        {running && (
          <div className="flex items-center gap-2 rounded-xl bg-accent-soft px-4 py-3 text-xs text-muted" role="status">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
            <span className="min-w-0 flex-1 truncate">
              {lastThought
                ? t('正在思考：{text}', { text: lastThought })
                : job.tools.length
                  ? t('正在查看：{files}', { files: job.tools.join('、') })
                  : t('正在提炼 {range} 的内容…', { range: windowLabel(job.grain, job.from) })}
            </span>
            {job.outChars > 0 && <span className="shrink-0">{t('已写 {n} 字', { n: job.outChars })}</span>}
          </div>
        )}

        {!!error && (
          <p className="flex gap-1.5 rounded-xl bg-danger/8 px-4 py-3 text-xs whitespace-pre-wrap text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        {job?.status === 'stopped' && (
          <p className="rounded-xl bg-sel/50 px-4 py-3 text-xs text-subtle">{t('已停止提炼')}</p>
        )}

        {done && !!job.skipped?.length && (
          <p className="flex gap-1.5 rounded-xl bg-warning/8 px-4 py-3 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('这些项目在这段时间没有对话，已跳过：{names}', { names: job.skipped.join('、') })}
          </p>
        )}

        {done && (
          <section aria-label={t('提炼结果')} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-[0.9375rem] font-semibold">{t('提炼结果')}</h2>
              <span className="text-xs text-subtle">
                {[
                  windowLabel(job.grain, job.from),
                  job.source === 'reports'
                    ? t('{n} 份报告', { n: job.reportCount })
                    : t('{n} 个对话', { n: job.taskCount }),
                  t('{n} 条分项', { n: job.items.length }),
                ].join(' · ')}
              </span>
            </div>
            {job.items.length ? (
              <>
                <EntryList entries={job.items} adopted={adopted} onToggle={onToggle} onAdoptAll={onAdoptAll} />
                <ConfirmBar entries={job.items} adopted={adopted} busy={confirming} onConfirm={onConfirm} />
              </>
            ) : (
              <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[0.8125rem] text-subtle">
                {job.taskCount || job.reportCount
                  ? t('这段时间的记录里没有可写进报告的需求或 Bug。')
                  : t('这段时间没有可提炼的内容。')}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  )
}
