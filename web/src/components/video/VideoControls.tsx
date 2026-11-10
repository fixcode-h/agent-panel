// 截帧弹窗的播放控制条：像视频播放器一样浮在画面下方（用户 2026-11-07 要的：按钮和进度条都悬浮在画面上，画面才能更大）。
// 上面一行是进度条（截下来的帧标在上面、截帧范围画成高亮的一段、两端把手可以拖），
// 下面一行左边是上一帧 · 播放 / 暂停 · 下一帧和时间，中间设范围的起点终点，右边是截取当前帧和帧播放。
import { useRef, useState } from 'react'
import { Camera, ChevronLeft, ChevronRight, Film, Loader2, Pause, Play, X } from 'lucide-react'
import { RANGE_MIN, timeText, type VideoFrame, type VideoRange } from '@shared/video'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 浮在画面上的按钮：深色半透明底上的白色图标 */
const glass =
  'grid cursor-pointer place-items-center rounded-full text-white/90 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none'
const pill =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-footnote text-white/90 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none'

export function PlayerBar(p: {
  cur: number
  duration: number
  frames: VideoFrame[]
  viewId: string | null
  range: VideoRange | null
  playing: boolean
  loading: boolean
  sliding: boolean
  noPlayer: boolean
  busy: boolean
  onSeek: (t: number) => void
  onFrame: (f: VideoFrame) => void
  onRange: (r: VideoRange) => void
  onPrev: () => void
  onNext: () => void
  onPlay: () => void
  onSlides: () => void
  onSetIn: () => void
  onSetOut: () => void
  onClearRange: () => void
  onCapture: () => void
}) {
  const hasFrames = p.frames.length > 0
  return (
    <div className="flex flex-col gap-1.5 px-4 pt-10 pb-3">
      <Scrubber {...p} />
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={cn(glass, 'h-9 w-9')}
          onClick={p.onPrev}
          disabled={!hasFrames}
          aria-label={t('上一帧')}
          title={t('上一帧（←）')}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          type="button"
          className={cn(glass, 'h-10 w-10 bg-white/10')}
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
          className={cn(glass, 'h-9 w-9')}
          onClick={p.onNext}
          disabled={!hasFrames}
          aria-label={t('下一帧')}
          title={t('下一帧（→）')}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
        <span className="ml-2 font-mono text-footnote text-white/90 tabular-nums">
          {timeText(p.cur)}
          <span className="text-white/50"> / {timeText(p.duration)}</span>
        </span>

        <span className="mx-2 h-4 w-px bg-white/20" aria-hidden />
        <button
          type="button"
          className={pill}
          onClick={p.onSetIn}
          disabled={p.busy}
          title={t('把当前位置设为起点（I）')}
        >
          <span className="font-mono text-micro text-white/60">I</span>
          {t('起点')}
        </button>
        <button
          type="button"
          className={pill}
          onClick={p.onSetOut}
          disabled={p.busy}
          title={t('把当前位置设为终点（O）')}
        >
          <span className="font-mono text-micro text-white/60">O</span>
          {t('终点')}
        </button>
        {p.range && (
          <span className="inline-flex h-7 items-center gap-1 rounded-full bg-accent/85 pr-1 pl-2.5 font-mono text-micro text-white tabular-nums">
            {timeText(p.range.start)} – {timeText(p.range.end)}
            <button
              type="button"
              onClick={p.onClearRange}
              disabled={p.busy}
              aria-label={t('清除范围')}
              title={t('清除范围')}
              className="grid h-5 w-5 cursor-pointer place-items-center rounded-full hover:bg-white/20"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}

        <span className="flex-1" />
        <button
          type="button"
          className={pill}
          onClick={p.onSlides}
          disabled={!hasFrames}
          aria-pressed={p.sliding}
          title={t('一张一张放截下来的帧')}
        >
          {p.sliding ? <Pause className="h-3.5 w-3.5" /> : <Film className="h-3.5 w-3.5" />}
          {p.sliding ? t('停止帧播放') : t('帧播放')}
        </button>
        <button
          type="button"
          onClick={p.onCapture}
          disabled={p.busy}
          title={t('截取当前位置（K）')}
          className="ml-1 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-white px-4 text-body font-medium text-black shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
        >
          <Camera className="h-4 w-4" />
          {t('截取当前帧')}
        </button>
      </div>
    </div>
  )
}

/**
 * 进度条：点、拖都能跳到那一刻（自己处理指针，不用原生 range：原生的轨道画不了帧标记和范围）。
 * 悬停时轨道变粗、显示那一刻的时间；截下来的帧是轨道上方的小刻度（手动强调色），点刻度看那一帧；
 * 截帧范围是轨道上一段强调色，两端的把手能拖，范围外的刻度变淡
 */
function Scrubber(p: {
  cur: number
  duration: number
  frames: VideoFrame[]
  viewId: string | null
  range: VideoRange | null
  onSeek: (t: number) => void
  onFrame: (f: VideoFrame) => void
  onRange: (r: VideoRange) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  /** 正在拖什么：进度、范围起点、范围终点 */
  const drag = useRef<'seek' | 'start' | 'end' | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const pct = (x: number) => `${p.duration > 0 ? (Math.min(Math.max(0, x), p.duration) / p.duration) * 100 : 0}%`
  const timeAt = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width) return 0
    return Math.min(Math.max(0, ((clientX - r.left) / r.width) * p.duration), p.duration)
  }
  const apply = (which: 'seek' | 'start' | 'end', at: number) => {
    if (which === 'seek') return p.onSeek(at)
    if (!p.range) return
    // 两端之间至少留 RANGE_MIN，拖过头时停在另一端旁边，不对调
    p.onRange(
      which === 'start'
        ? { start: Math.min(at, p.range.end - RANGE_MIN), end: p.range.end }
        : { start: p.range.start, end: Math.max(at, p.range.start + RANGE_MIN) },
    )
  }
  const down = (which: 'seek' | 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation()
    box.current?.setPointerCapture(e.pointerId)
    drag.current = which
    apply(which, timeAt(e.clientX))
  }
  const handle = (which: 'start' | 'end') => (
    <button
      type="button"
      aria-label={which === 'start' ? t('截帧范围起点') : t('截帧范围终点')}
      title={`${which === 'start' ? t('起点') : t('终点')} · ${timeText(which === 'start' ? p.range!.start : p.range!.end)}`}
      style={{ left: pct(which === 'start' ? p.range!.start : p.range!.end) }}
      onPointerDown={down(which)}
      onKeyDown={(e) => {
        // 键盘微调：← → 每次 0.1 秒（Shift 1 秒）
        const d = (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0) * (e.shiftKey ? 1 : 0.1)
        if (!d || !p.range) return
        e.preventDefault()
        e.stopPropagation()
        apply(which, (which === 'start' ? p.range.start : p.range.end) + d)
      }}
      className="absolute top-1/2 z-10 h-4 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded-full border-2 border-white bg-accent shadow focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
    />
  )
  return (
    <div className="relative">
      {/* 帧刻度：轨道上方一排，点了看那一帧 */}
      <div className="relative h-3">
        {p.frames.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => p.onFrame(f)}
            title={`${f.source === 'manual' ? t('手动') : t('自动')} · ${timeText(f.time)}`}
            aria-label={t('看 {time} 的帧', { time: timeText(f.time) })}
            style={{ left: pct(f.time) }}
            className={cn(
              'absolute top-0 h-2.5 w-1 -translate-x-1/2 cursor-pointer rounded-full transition-transform hover:scale-y-125',
              f.source === 'manual' ? 'bg-accent' : 'bg-white/80',
              p.range && (f.time < p.range.start || f.time > p.range.end) && 'opacity-35',
              p.viewId === f.id && 'ring-2 ring-white',
            )}
          />
        ))}
      </div>
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={t('视频位置')}
        aria-valuemin={0}
        aria-valuemax={Math.round(p.duration * 10) / 10}
        aria-valuenow={Math.round(p.cur * 10) / 10}
        aria-valuetext={timeText(p.cur)}
        className="group relative flex h-4 cursor-pointer touch-none items-center outline-none"
        onPointerDown={down('seek')}
        onPointerMove={(e) => {
          setHover(timeAt(e.clientX))
          if (drag.current) apply(drag.current, timeAt(e.clientX))
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          const d = (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0) * (e.shiftKey ? 5 : 1)
          if (!d) return
          // 方向键默认是上一帧 / 下一帧（弹窗的快捷键）；焦点在进度条上时改成前后跳 1 秒（Shift 5 秒）
          e.preventDefault()
          e.stopPropagation()
          p.onSeek(Math.min(Math.max(0, p.cur + d), p.duration))
        }}
      >
        {/* 截帧范围：比轨道高一圈的强调色底，播放进度盖过去时上下沿照样看得见 */}
        {p.range && (
          <div
            className="pointer-events-none absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-accent/80"
            style={{ left: pct(p.range.start), width: `calc(${pct(p.range.end)} - ${pct(p.range.start)})` }}
          />
        )}
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-[height] group-hover:h-1.5 group-focus-visible:h-1.5">
          <div className="absolute inset-y-0 left-0 bg-white" style={{ width: pct(p.cur) }} />
        </div>
        {/* 播放头 */}
        <div
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-white shadow transition-transform group-hover:scale-100 group-focus-visible:scale-100"
          style={{ left: pct(p.cur) }}
        />
        {p.range && handle('start')}
        {p.range && handle('end')}
        {hover !== null && (
          <span
            className="pointer-events-none absolute bottom-5 -translate-x-1/2 rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-micro text-white tabular-nums"
            style={{ left: pct(hover) }}
          >
            {timeText(hover)}
          </span>
        )}
      </div>
    </div>
  )
}
