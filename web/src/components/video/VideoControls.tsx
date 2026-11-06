// 截帧弹窗的播放控制和时间轴：上一帧 · 播放 / 暂停 · 下一帧 · 帧播放，时间轴上标着截下来的帧
import { ChevronLeft, ChevronRight, Film, Loader2, Pause, Play } from 'lucide-react'
import { timeText, type VideoFrame } from '@shared/video'
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

/** 时间轴：拖动跳到那一刻；截下来的帧标在上面（手动的用强调色），点标记看那一帧 */
export function Timeline(p: {
  cur: number
  duration: number
  frames: VideoFrame[]
  viewId: string | null
  onSeek: (t: number) => void
  onFrame: (f: VideoFrame) => void
}) {
  const pct = (x: number) => `${p.duration > 0 ? (x / p.duration) * 100 : 0}%`
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-right font-mono text-footnote text-muted tabular-nums">
        {timeText(p.cur)}
      </span>
      <div className="relative h-7 min-w-0 flex-1">
        <input
          type="range"
          aria-label={t('视频位置')}
          min={0}
          max={p.duration || 0}
          step={0.01}
          value={Math.min(p.cur, p.duration)}
          onChange={(e) => p.onSeek(Number(e.target.value))}
          className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2 cursor-pointer accent-(--accent)"
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
              p.viewId === f.id && 'ring-2 ring-focus',
            )}
          />
        ))}
      </div>
      <span className="w-14 shrink-0 font-mono text-footnote text-subtle tabular-nums">{timeText(p.duration)}</span>
    </div>
  )
}
