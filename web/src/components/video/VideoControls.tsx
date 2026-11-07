// 截帧弹窗的播放控制和时间轴：上一帧 · 播放 / 暂停 · 下一帧 · 帧播放，时间轴上标着截下来的帧和截帧范围
import { useRef } from 'react'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  Film,
  Loader2,
  Pause,
  Play,
  Scissors,
} from 'lucide-react'
import { RANGE_MIN, timeText, type VideoFrame, type VideoRange } from '@shared/video'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 播放控制：上一帧 · 播放 / 暂停视频 · 下一帧，右边是帧播放 */
export function Transport(p: {
  playing: boolean
  /** 播放器在缓冲：按钮上转圈，用户看得出不是没反应 */
  loading: boolean
  sliding: boolean
  noPlayer: boolean
  hasFrames: boolean
  onPrev: () => void
  onNext: () => void
  onPlay: () => void
  onSlides: () => void
}) {
  const round =
    'grid cursor-pointer place-items-center rounded-full text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div className="relative flex items-center justify-center gap-3">
      <button
        type="button"
        className={cn(round, 'h-9 w-9 border border-line-strong')}
        onClick={p.onPrev}
        disabled={!p.hasFrames}
        aria-label={t('上一帧')}
        title={t('上一帧（←）')}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={cn(round, 'h-11 w-11 bg-primary text-on-primary hover:bg-primary hover:opacity-90')}
        onClick={p.onPlay}
        disabled={p.noPlayer}
        aria-label={p.playing ? t('暂停') : t('播放')}
        title={p.noPlayer ? t('浏览器放不了这个格式') : p.playing ? t('暂停（空格）') : t('播放（空格）')}
      >
        {p.playing && p.loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : p.playing ? (
          <Pause className="h-5 w-5 fill-current" />
        ) : (
          <Play className="ml-0.5 h-5 w-5 fill-current" />
        )}
      </button>
      <button
        type="button"
        className={cn(round, 'h-9 w-9 border border-line-strong')}
        onClick={p.onNext}
        disabled={!p.hasFrames}
        aria-label={t('下一帧')}
        title={t('下一帧（→）')}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={p.onSlides}
        disabled={!p.hasFrames}
        aria-pressed={p.sliding}
        className="absolute right-0 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-body text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-text"
      >
        {p.sliding ? <Pause className="h-3.5 w-3.5" /> : <Film className="h-3.5 w-3.5" />}
        {p.sliding ? t('停止帧播放') : t('帧播放')}
      </button>
    </div>
  )
}

/**
 * 时间轴：拖动跳到那一刻；截下来的帧标在上面（手动的用强调色），点标记看那一帧。
 * 选了截帧范围时，范围画在轨道下面，两端的把手可以拖；范围外的帧标记变淡
 */
export function Timeline(p: {
  cur: number
  duration: number
  frames: VideoFrame[]
  viewId: string | null
  range: VideoRange | null
  onSeek: (t: number) => void
  onFrame: (f: VideoFrame) => void
  onRange: (r: VideoRange) => void
}) {
  const pct = (x: number) => `${p.duration > 0 ? (x / p.duration) * 100 : 0}%`
  const box = useRef<HTMLDivElement>(null)
  /** 拖把手：按住时记下拖的是哪一端，松开清掉 */
  const drag = useRef<'start' | 'end' | null>(null)
  const timeAt = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width) return 0
    return Math.min(Math.max(0, ((clientX - r.left) / r.width) * p.duration), p.duration)
  }
  const move = (e: React.PointerEvent) => {
    const which = drag.current
    if (!which || !p.range) return
    const at = timeAt(e.clientX)
    // 两端之间至少留 RANGE_MIN，拖过头时停在另一端旁边，不对调
    p.onRange(
      which === 'start'
        ? { start: Math.min(at, p.range.end - RANGE_MIN), end: p.range.end }
        : { start: p.range.start, end: Math.max(at, p.range.start + RANGE_MIN) },
    )
  }
  const handle = (which: 'start' | 'end') => (
    <button
      type="button"
      aria-label={which === 'start' ? t('截帧范围起点') : t('截帧范围终点')}
      title={`${which === 'start' ? t('起点') : t('终点')} · ${timeText(which === 'start' ? p.range!.start : p.range!.end)}`}
      style={{ left: pct(which === 'start' ? p.range!.start : p.range!.end) }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = which
      }}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e) => {
        // 键盘微调：← → 每次 0.1 秒（Shift 1 秒）
        const d = (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0) * (e.shiftKey ? 1 : 0.1)
        if (!d || !p.range) return
        e.preventDefault()
        e.stopPropagation()
        const r = p.range
        p.onRange(
          which === 'start'
            ? { start: Math.min(Math.max(0, r.start + d), r.end - RANGE_MIN), end: r.end }
            : { start: r.start, end: Math.max(Math.min(p.duration, r.end + d), r.start + RANGE_MIN) },
        )
      }}
      className="absolute bottom-0 h-3.5 w-2.5 -translate-x-1/2 cursor-ew-resize touch-none rounded-sm border border-accent bg-panel hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
    />
  )
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-right font-mono text-footnote text-muted tabular-nums">
        {timeText(p.cur)}
      </span>
      <div ref={box} className={cn('relative min-w-0 flex-1', p.range ? 'h-9' : 'h-7')}>
        <input
          type="range"
          aria-label={t('视频位置')}
          min={0}
          max={p.duration || 0}
          step={0.01}
          value={Math.min(p.cur, p.duration)}
          onChange={(e) => p.onSeek(Number(e.target.value))}
          className={cn(
            'absolute inset-x-0 w-full -translate-y-1/2 cursor-pointer accent-(--accent)',
            p.range ? 'top-[14px]' : 'top-1/2',
          )}
        />
        {p.frames.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => p.onFrame(f)}
            title={`${f.source === 'manual' ? t('手动') : t('自动')} · ${timeText(f.time)}`}
            aria-label={t('看 {time} 的帧', { time: timeText(f.time) })}
            style={{ left: pct(f.time) }}
            className={cn(
              'absolute top-0 h-2.5 w-1.5 -translate-x-1/2 cursor-pointer rounded-sm',
              f.source === 'manual' ? 'bg-accent' : 'bg-muted',
              p.range && (f.time < p.range.start || f.time > p.range.end) && 'opacity-35',
              p.viewId === f.id && 'ring-2 ring-focus',
            )}
          />
        ))}
        {p.range && (
          <>
            <div className="absolute inset-x-0 bottom-1.5 h-0.5 rounded-full bg-line" aria-hidden />
            <div
              className="absolute bottom-1 h-1.5 rounded-full bg-accent"
              style={{ left: pct(p.range.start), width: pct(p.range.end - p.range.start) }}
              aria-hidden
            />
            {handle('start')}
            {handle('end')}
          </>
        )}
      </div>
      <span className="w-14 shrink-0 font-mono text-footnote text-subtle tabular-nums">{timeText(p.duration)}</span>
    </div>
  )
}

/**
 * 截帧范围：把当前位置设为起点 / 终点（快捷键 I / O，和剪辑软件一样），显示选了哪一段，清除回到整段。
 * 自动截帧只在这一段里截；手动截帧不受影响
 */
export function RangeBar(p: {
  range: VideoRange | null
  disabled: boolean
  onStart: () => void
  onEnd: () => void
  onClear: () => void
}) {
  const btn =
    'inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line-strong px-2 text-footnote text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-footnote text-muted">
        <Scissors className="h-3.5 w-3.5" />
        {t('截帧范围')}
      </span>
      <span className="font-mono text-footnote text-fg tabular-nums">
        {p.range
          ? t('{from} – {to}（{len} 秒）', {
              from: timeText(p.range.start),
              to: timeText(p.range.end),
              len: (p.range.end - p.range.start).toFixed(1),
            })
          : t('整段视频')}
      </span>
      <button
        type="button"
        className={btn}
        disabled={p.disabled}
        onClick={p.onStart}
        title={t('把当前位置设为起点（I）')}
      >
        <ArrowRightToLine className="h-3.5 w-3.5" />
        {t('设为起点')}
      </button>
      <button
        type="button"
        className={btn}
        disabled={p.disabled}
        onClick={p.onEnd}
        title={t('把当前位置设为终点（O）')}
      >
        <ArrowLeftToLine className="h-3.5 w-3.5" />
        {t('设为终点')}
      </button>
      {p.range && (
        <button type="button" className={btn} disabled={p.disabled} onClick={p.onClear}>
          {t('清除范围')}
        </button>
      )}
    </div>
  )
}
