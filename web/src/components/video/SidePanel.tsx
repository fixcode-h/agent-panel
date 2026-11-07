// 截帧弹窗的右栏（用户 2026-11-07 要的重新设计：操作都收进右栏，左边留给画面）：
// 截帧范围（整段 + 记下来的几段命名范围，点一段选中，自动截帧只在选中的那段里截）、自动截帧（方式、张数、去掉相似帧、清除）、画面增强。
import { Plus, ScanSearch, Trash2, WandSparkles, Loader2, Layers, Scissors, Sparkles } from 'lucide-react'
import { AUTO_MAX, RANGE_MIN, timeText, type AutoMode } from '@shared/video'
import { RANGES_MAX, rangeLabel, type NamedRange } from '@shared/video-tools'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/input'

const COUNTS = [4, 6, 8, 10, 12, 16, 24].filter((n) => n <= AUTO_MAX)

/** 新范围的 id：只在这个视频里唯一就够 */
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** 从当前位置起的一段新范围：默认取整段的 1/5（至少 RANGE_MIN），放不下时往前挪 */
export function rangeFrom(at: number, duration: number, name = ''): NamedRange {
  const len = Math.min(duration, Math.max(RANGE_MIN, duration / 5))
  const start = Math.max(0, Math.min(at, duration - len))
  return { id: newId(), name, start, end: Math.min(duration, start + len) }
}

function Section({
  icon: Icon,
  title,
  extra,
  children,
}: {
  icon: typeof Plus
  title: string
  extra?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-line px-4 py-3.5 last:border-b-0">
      <h3 className="flex h-5 items-center gap-1.5 text-footnote font-medium tracking-wide text-muted">
        <Icon className="h-3.5 w-3.5" />
        {title}
        <span className="flex-1" />
        {extra}
      </h3>
      {children}
    </section>
  )
}

export function SidePanel(p: {
  duration: number
  cur: number
  busy: boolean
  ranges: NamedRange[]
  /** 选中的范围 id；空是整段 */
  active: string
  onActive: (id: string) => void
  onRanges: (list: NamedRange[]) => void
  mode: AutoMode
  count: number
  onMode: (m: AutoMode) => void
  onCount: (n: number) => void
  autoRunning: boolean
  onAuto: () => void
  onDedupe: () => void
  manualCount: number
  autoCount: number
  onClear: (which: 'manual' | 'auto') => void
  /** 画面增强（EnhanceBar） */
  enhance: React.ReactNode
}) {
  const active = p.ranges.find((r) => r.id === p.active)
  const add = () => {
    const r = rangeFrom(p.cur, p.duration)
    p.onRanges([...p.ranges, r])
    p.onActive(r.id)
  }
  const item = (on: boolean) =>
    cn(
      'group flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-body transition-colors',
      on ? 'bg-accent-soft text-fg ring-1 ring-accent/50' : 'text-muted hover:bg-hover hover:text-fg',
    )
  const dot = (on: boolean) => (
    <span
      className={cn(
        'h-3.5 w-3.5 shrink-0 rounded-full border-2',
        on ? 'border-accent bg-accent' : 'border-line-strong',
      )}
      style={on ? { boxShadow: 'inset 0 0 0 2px var(--color-panel)' } : undefined}
      aria-hidden
    />
  )
  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel" data-surface="">
      <Section
        icon={Scissors}
        title={t('截帧范围')}
        extra={
          <button
            type="button"
            onClick={add}
            disabled={p.busy || p.ranges.length >= RANGES_MAX || !(p.duration > RANGE_MIN)}
            title={t('从当前位置新建一段范围（也可以在进度条上按 I / O 设起点终点）')}
            className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 text-footnote font-normal text-accent-text hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('新范围')}
          </button>
        }
      >
        <div className="flex flex-col gap-1" role="radiogroup" aria-label={t('截帧范围')}>
          <div
            role="radio"
            tabIndex={0}
            aria-checked={!active}
            className={item(!active)}
            onClick={() => p.onActive('')}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), p.onActive(''))}
          >
            {dot(!active)}
            <span className="flex-1 truncate">{t('整段视频')}</span>
            <span className="font-mono text-micro text-subtle tabular-nums">{timeText(p.duration, 0)}</span>
          </div>
          {p.ranges.map((r, i) => {
            const on = r.id === p.active
            return (
              <div
                key={r.id}
                role="radio"
                tabIndex={0}
                aria-checked={on}
                className={item(on)}
                onClick={() => p.onActive(r.id)}
                onKeyDown={(e) =>
                  e.target === e.currentTarget &&
                  (e.key === 'Enter' || e.key === ' ') &&
                  (e.preventDefault(), p.onActive(r.id))
                }
              >
                {dot(on)}
                <div className="flex min-w-0 flex-1 flex-col">
                  <input
                    value={r.name}
                    maxLength={40}
                    placeholder={rangeLabel(r, i, (n) => t('范围 {n}', { n }))}
                    aria-label={t('范围名称')}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={() => p.onActive(r.id)}
                    onChange={(e) =>
                      p.onRanges(p.ranges.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))
                    }
                    className="h-5 min-w-0 rounded bg-transparent text-body text-fg outline-none placeholder:text-fg focus:bg-field focus:px-1 focus:placeholder:text-subtle"
                  />
                  <span className="font-mono text-micro text-subtle tabular-nums">
                    {timeText(r.start)} – {timeText(r.end)} · {timeText(r.end - r.start)}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={t('删除这段范围')}
                  title={t('删除这段范围')}
                  disabled={p.busy}
                  onClick={(e) => {
                    e.stopPropagation()
                    p.onRanges(p.ranges.filter((x) => x.id !== r.id))
                    if (on) p.onActive('')
                  }}
                  className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
        <p className="text-footnote leading-relaxed text-subtle">
          {active
            ? t('自动截帧只在这段里截，范围外截过的自动帧留着。拖进度条上的两个把手可以调整。')
            : t('在画面下方的进度条上按 I / O（或点「起点」「终点」）圈出一段，会记成一段命名范围，下次打开还在。')}
        </p>
      </Section>

      <Section icon={WandSparkles} title={t('自动截帧')}>
        <Segmented
          size="sm"
          fill
          label={t('自动截帧方式')}
          value={p.mode}
          onChange={p.onMode}
          options={[
            { id: 'scene', label: t('画面变化') },
            { id: 'screen', label: t('录屏') },
            { id: 'uniform', label: t('均匀') },
          ]}
        />
        <p className="text-footnote leading-relaxed text-subtle">
          {p.mode === 'scene'
            ? t('在镜头切换、画面明显变了的地方截，适合剪辑过的视频和游戏实机。')
            : p.mode === 'screen'
              ? t('跳过一动不动的画面，在操作发生的地方截，适合软件录屏。')
              : t('按时长平均截。')}{' '}
          {t('每个时间点在前后 0.25 秒里挑最清楚的一张。')}
        </p>
        <div className="flex items-center gap-1.5">
          <Select
            size="sm"
            aria-label={t('自动截几帧')}
            value={String(p.count)}
            onChange={(e) => p.onCount(Number(e.target.value))}
            className="w-[92px] shrink-0"
            options={COUNTS.map((n) => ({ value: String(n), label: t('{n} 帧', { n }) }))}
          />
          <Button variant="primary" size="sm" className="flex-1" disabled={p.busy} onClick={p.onAuto}>
            {p.autoRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
            {active
              ? t('在「{name}」里截', {
                  name: rangeLabel(active, p.ranges.indexOf(active), (n) => t('范围 {n}', { n })),
                })
              : t('自动截帧')}
          </Button>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={p.busy || p.manualCount + p.autoCount < 2}
          onClick={p.onDedupe}
          title={t('几乎一样的自动帧只留最清楚的一张，手动截的不删')}
        >
          <Layers className="h-3.5 w-3.5" />
          {t('去掉相似帧')}
        </Button>
        <div className="-mx-1 flex items-center justify-between">
          <Button variant="ghost" size="sm" disabled={p.busy || !p.autoCount} onClick={() => p.onClear('auto')}>
            <Trash2 className="h-3.5 w-3.5" />
            {t('清除自动（{n}）', { n: p.autoCount })}
          </Button>
          <Button variant="ghost" size="sm" disabled={p.busy || !p.manualCount} onClick={() => p.onClear('manual')}>
            {t('清除手动（{n}）', { n: p.manualCount })}
          </Button>
        </div>
      </Section>

      <Section icon={Sparkles} title={t('画面增强')}>
        {p.enhance}
      </Section>
    </aside>
  )
}
