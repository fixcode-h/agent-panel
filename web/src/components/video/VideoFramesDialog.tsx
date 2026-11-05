// 视频截帧弹窗：点输入框里的视频卡片打开（用户 2026-11-05 定的：不把视频发给 Agent，发截出来的帧图片）。
// 上面是播放器 / 帧画面（占满剩下的高度），下面是「上一帧 · 播放视频 · 下一帧 · 帧播放」、时间轴（帧的位置标在上面）、
// 截帧和增强的操作、截下来的帧。手动截的帧自动截帧时一直保留，只能用「清除手动帧」或单张删掉。
// 选好的帧记在视频卡片上，发送时换成这些帧图片的路径。双击帧看大图，可以缩放、拖动看细节。
// 原视频只读：播放走 /api/video/stream，截帧、增强都在服务端用 FFmpeg 写到数据目录（server/video/）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Film, Loader2, Sparkles, Trash2, WandSparkles, X } from 'lucide-react'
import type { Attachment } from '@shared/schema'
import {
  AUTO_MAX,
  FFMPEG_ENHANCE,
  browserPlayable,
  frameName,
  timeText,
  type AutoMode,
  type EnhanceMethod,
  type FfmpegStatus,
  type VideoFrame,
  type VideoSession,
} from '@shared/video'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { frameUrl, videoApi, videoPreviewUrl, videoStreamUrl } from '@/lib/video-api'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Lightbox } from '@/components/ui/lightbox'
import { FfmpegSetup } from './FfmpegSetup'
import { FrameStrip } from './FrameStrip'
import { Timeline, Transport } from './VideoControls'
import { WorkBar, type Work } from './WorkBar'

/** 要截帧的视频：本机绝对路径；chosen 是上次选好的帧（再打开时照着勾上） */
export interface VideoTarget {
  path: string
  name: string
  chosen?: Attachment[]
}

/** 帧播放每张停多久 */
const SLIDE_MS = 800
const COUNTS = [4, 6, 8, 10, 16, 24].filter((n) => n <= AUTO_MAX)

/** 这张帧现在显示 / 发送哪一份：有增强图且没切回原图时用增强图 */
const shownFile = (f: VideoFrame, original: boolean) => (f.enhanced && !original ? f.enhanced.file : f.file)

export function VideoFramesDialog({
  target,
  onClose,
  onInsert,
}: {
  target: VideoTarget | null
  onClose: () => void
  /** 选好的帧交回视频卡片（发送时换成这些图片） */
  onInsert: (list: Attachment[]) => void
}) {
  return (
    <Modal open={!!target} onOpenChange={(o) => !o && onClose()} title={t('从视频截取帧')} size="full" bare>
      {target && <Body key={target.path} target={target} onClose={onClose} onInsert={onInsert} />}
    </Modal>
  )
}

function Body({
  target,
  onClose,
  onInsert,
}: {
  target: VideoTarget
  onClose: () => void
  onInsert: (list: Attachment[]) => void
}) {
  const [status, setStatus] = useState<FfmpegStatus | null>(null)
  const [session, setSession] = useState<VideoSession | null>(null)
  const [error, setError] = useState('')
  /** 正在跑的截帧 / 增强：同一时间只跑一个，进度画在底部 */
  const [work, setWork] = useState<Work | null>(null)
  const [cur, setCur] = useState(0)
  const [playing, setPlaying] = useState(false)
  /** 播放器在缓冲（点了播放、画面还没动） */
  const [loading, setLoading] = useState(false)
  /** 画面上显示的帧；为空时显示视频本身 */
  const [viewId, setViewId] = useState<string | null>(null)
  const [sliding, setSliding] = useState(false)
  const [original, setOriginal] = useState(false)
  /** 不发送的帧（默认全发；再打开时按上次选的） */
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<AutoMode>('scene')
  const [count, setCount] = useState(8)
  const [methods, setMethods] = useState<EnhanceMethod[]>([])
  const [method, setMethod] = useState(FFMPEG_ENHANCE)
  /** 浏览器播不了这个格式：改用 FFmpeg 取的画面预览 */
  const [noPlayer, setNoPlayer] = useState(!browserPlayable(target.name))
  const [previewT, setPreviewT] = useState(0)
  /** 全屏看大图的那一张（frames 里的下标） */
  const [zoomAt, setZoomAt] = useState<number | undefined>(undefined)
  const video = useRef<HTMLVideoElement>(null)
  /** 取消正在跑的截帧 / 增强 */
  const stop = useRef<AbortController | null>(null)

  const frames = useMemo(() => session?.frames ?? [], [session])
  const duration = session?.info.duration ?? 0
  const view = frames.find((f) => f.id === viewId) ?? null
  const ref = session ? { key: session.key, path: session.path } : null
  const busy = !!work

  // 先看有没有 FFmpeg，有了再打开视频（探测时长、读回之前截过的帧）
  const chosen0 = useRef(target.chosen ?? [])
  const load = useCallback(async () => {
    setError('')
    try {
      const s = await videoApi.status()
      setStatus(s)
      if (!s.path) return
      const opened = await videoApi.open(target.path)
      // 上次选过帧：没选上的照旧不勾
      const had = new Set(chosen0.current.map((a) => a.path))
      if (had.size)
        setSkipped(
          new Set(opened.frames.filter((f) => !had.has(f.file) && !had.has(f.enhanced?.file ?? '')).map((f) => f.id)),
        )
      setSession(opened)
      setMethods((await videoApi.methods()).methods)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [target.path])
  useEffect(() => {
    void load()
  }, [load])
  // 下载 FFmpeg 时每秒看一次进度，下好了接着打开视频
  useEffect(() => {
    if (!status?.job?.running) return
    const id = setInterval(() => {
      void videoApi.status().then((s) => {
        setStatus(s)
        if (s.path) void load()
      })
    }, 1000)
    return () => clearInterval(id)
  }, [status?.job?.running, load])
  // 关弹窗时还在跑的截帧 / 增强一起停掉
  useEffect(() => () => stop.current?.abort(), [])

  // 播放器放不出来时：时间停下 250ms 后取这一刻的画面
  useEffect(() => {
    if (!noPlayer) return
    const id = setTimeout(() => setPreviewT(cur), 250)
    return () => clearTimeout(id)
  }, [cur, noPlayer])

  /** 跑一个会改帧的操作：同一时间只跑一个，出错原样提示；用户取消的不算出错 */
  const run = async (first: Work, fn: (signal: AbortSignal) => Promise<VideoSession | undefined>) => {
    if (work) return
    const ctl = new AbortController()
    stop.current = ctl
    setWork(first)
    try {
      const next = await fn(ctl.signal)
      if (next) setSession(next)
      return next
    } catch (e) {
      if (!ctl.signal.aborted) toast.error((e as Error).message)
    } finally {
      if (stop.current === ctl) stop.current = null
      setWork(null)
    }
  }

  const seek = (time: number) => {
    const at = Math.min(Math.max(0, time), duration)
    setCur(at)
    if (video.current) video.current.currentTime = at
  }
  const pause = () => {
    video.current?.pause()
    setPlaying(false)
  }
  /** 看某一张帧：视频停下并跳到那一刻，之后点播放从这里接着放 */
  const showFrame = (f: VideoFrame | undefined) => {
    if (!f) return
    pause()
    setViewId(f.id)
    seek(f.time)
  }
  const togglePlay = () => {
    setSliding(false)
    const v = video.current
    if (noPlayer || !v) return
    setViewId(null)
    if (!v.paused) return v.pause()
    // 停在结尾时从头放（时长按 FFmpeg 探测的算，可能比播放器的略短，拖到最后不一定算「放完」）
    if (v.ended || (v.duration > 0 && v.currentTime >= v.duration - 0.05)) v.currentTime = 0
    v.play().catch((e: DOMException) => {
      // play() 要等缓冲好才兑现，期间又点了暂停、看帧（都会调 pause()）时这个请求就被打断：
      // 这是用户要的结果，不是播放出错。以前把它当错误弹出来，就是「The play() request was interrupted by a call to pause()」
      if (e.name === 'AbortError') return
      // 浏览器解不了这个编码（比如部分 HEVC 录屏）：改用 FFmpeg 取画面预览
      if (e.name === 'NotSupportedError') return setNoPlayer(true)
      toast.error(e.message)
    })
  }
  /** 上一帧 / 下一帧：在截下来的帧之间走；看视频时按当前时间找前后最近的那张 */
  const step = (dir: -1 | 1) => {
    setSliding(false)
    if (!frames.length) return
    const i = view ? frames.indexOf(view) : -1
    if (i >= 0) return showFrame(frames[i + dir])
    showFrame(
      dir > 0 ? frames.find((f) => f.time > cur + 0.01) : [...frames].reverse().find((f) => f.time < cur - 0.01),
    )
  }
  // 帧播放：从当前这张（没有就从第一张）开始一张一张往后放，放到最后一张停
  useEffect(() => {
    if (!sliding) return
    const id = setInterval(() => {
      const i = view ? frames.indexOf(view) : -1
      const next = frames[i + 1]
      if (!next) return setSliding(false)
      setViewId(next.id)
      seek(next.time)
    }, SLIDE_MS)
    return () => clearInterval(id)
    // seek 每次渲染都是新的，只按帧和当前画面重排定时器
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sliding, view, frames])
  const toggleSlides = () => {
    if (sliding) return setSliding(false)
    if (!frames.length) return
    pause()
    if (!view || frames.indexOf(view) === frames.length - 1) showFrame(frames[0])
    setSliding(true)
  }

  const keyFrame = () =>
    ref &&
    void run({ kind: 'manual' }, () =>
      videoApi.manual(ref, video.current && !noPlayer ? video.current.currentTime : cur),
    ).then((s) => {
      // 新截的这张默认要发、画面切过去
      const added = s?.frames.find((f) => !frames.some((o) => o.id === f.id))
      if (added) setViewId(added.id)
    })
  /** 自动截帧：服务端先分析整段画面再一张张截，等结果时轮询进度画进度条 */
  const autoKey = () => {
    if (!ref) return
    void run({ kind: 'auto', progress: null }, async (signal) => {
      const poll = setInterval(() => {
        void videoApi
          .progress(ref.key)
          .then((r) => !signal.aborted && setWork((w) => (w?.kind === 'auto' ? { ...w, progress: r.progress } : w)))
          .catch(() => {})
      }, 400)
      try {
        return await videoApi.auto(ref, mode, count, signal)
      } finally {
        clearInterval(poll)
      }
    }).then((s) => {
      if (s && view && !s.frames.some((f) => f.id === view.id)) setViewId(null)
    })
  }
  const clear = (which: 'manual' | 'auto') =>
    ref &&
    void run({ kind: 'clear' }, () => videoApi.remove(ref, { which })).then((s) => {
      if (s && view && !s.frames.some((f) => f.id === view.id)) setViewId(null)
    })
  const removeOne = (f: VideoFrame) => {
    if (!ref) return
    if (viewId === f.id) setViewId(null)
    void run({ kind: 'clear' }, () => videoApi.remove(ref, { ids: [f.id] }))
  }
  const chosen = frames.filter((f) => !skipped.has(f.id))
  /** 增强选中的帧：一张一张发给服务端，正在处理的那张在帧条上标出来，处理完一张就换上一张的结果 */
  const enhance = () => {
    if (!ref) return
    const ids = chosen.map((f) => f.id)
    if (!ids.length) return toast.error(t('先勾选要处理的帧'))
    // 处理完默认看增强后的效果
    setOriginal(false)
    void run({ kind: 'enhance', cur: ids[0]!, queued: ids.slice(1), done: 0, total: ids.length }, async (signal) => {
      let last: VideoSession | undefined
      for (const [i, id] of ids.entries()) {
        if (signal.aborted) break
        setWork({ kind: 'enhance', cur: id, queued: ids.slice(i + 1), done: i, total: ids.length })
        last = await videoApi.enhance(ref, [id], method, signal)
        setSession(last)
      }
      return last
    })
  }
  const unenhance = () => ref && void run({ kind: 'clear' }, () => videoApi.unenhance(ref))

  // 键盘：空格播放 / 暂停，K 截取当前帧，← → 上一帧 / 下一帧（在输入框、下拉里打字、看大图时不接）
  const keys = useRef({ togglePlay, keyFrame, step })
  keys.current = { togglePlay, keyFrame, step }
  const zoomOpen = useRef(false)
  zoomOpen.current = zoomAt !== undefined
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (zoomOpen.current) return
      if (el?.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ') keys.current.togglePlay()
      else if (e.key === 'k' || e.key === 'K') keys.current.keyFrame()
      else if (e.key === 'ArrowLeft') keys.current.step(-1)
      else if (e.key === 'ArrowRight') keys.current.step(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  /** 发给 Agent 时每张帧的附件：同一时刻截了两次的名字加序号，输入框和消息里的卡片才分得清 */
  const attachmentsOf = (list: VideoFrame[]): Attachment[] => {
    if (!session) return []
    const taken = new Set<string>()
    return list.map((f) => {
      const enh = !!f.enhanced && !original
      let name = frameName(session.name, f.time, enh)
      for (let i = 2; taken.has(name); i++) name = frameName(session.name, f.time, enh).replace(/\.png$/, ` (${i}).png`)
      taken.add(name)
      return { name, path: shownFile(f, original), size: enh ? (f.enhanced?.bytes ?? 0) : f.bytes, mime: 'image/png' }
    })
  }
  // 附件不限个数：选中的帧全部记到视频卡片上
  const insert = () => {
    if (!session || !chosen.length) return
    onInsert(attachmentsOf(chosen))
    onClose()
  }
  const manualCount = frames.filter((f) => f.source === 'manual').length
  const autoCount = frames.length - manualCount
  const anyEnhanced = frames.some((f) => f.enhanced)
  const zoomImages = useMemo(
    () =>
      session
        ? frames.map((f) => ({ src: frameUrl(shownFile(f, original)), name: frameName(session.name, f.time) }))
        : [],
    [frames, original, session],
  )
  const working =
    work?.kind === 'enhance'
      ? { cur: work.cur, queued: new Set(work.queued) }
      : { cur: null, queued: new Set<string>() }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[2.0625rem] shrink-0 items-center gap-2 border-b border-(color:--modal-edge) pr-1.5 pl-2.5">
        <Film className="h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 truncate text-body font-medium text-fg">{t('从视频截取帧')}</span>
        <span className="min-w-0 truncate text-footnote text-subtle" title={target.path}>
          {target.name}
          {session &&
            ` · ${timeText(duration, 0)} · ${session.info.width}×${session.info.height}${session.info.fps ? ` · ${Math.round(session.info.fps)} fps` : ''}`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label={t('关闭')}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* 画面占满剩下的高度；窗口太矮时整块滚动，画面至少留 220px */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 [&>*]:shrink-0">
        {error ? (
          <div
            className="flex flex-col items-start gap-2 rounded-xl bg-danger/8 p-4 text-body text-danger"
            data-surface=""
          >
            {error}
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t('重试')}
            </Button>
          </div>
        ) : !status ? (
          <Loading text={t('正在检查 FFmpeg')} />
        ) : !status.path ? (
          <FfmpegSetup status={status} onStatus={setStatus} />
        ) : !session ? (
          <Loading text={t('正在读取视频')} />
        ) : (
          <>
            <div className="relative min-h-[220px] flex-1! overflow-hidden rounded-xl bg-black" data-surface="">
              {!noPlayer && (
                <video
                  ref={video}
                  src={videoStreamUrl(session.path)}
                  preload="metadata"
                  playsInline
                  className={cn('absolute inset-0 h-full w-full object-contain', view && 'invisible')}
                  onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => {
                    setPlaying(false)
                    setLoading(false)
                  }}
                  onWaiting={() => setLoading(true)}
                  onPlaying={() => setLoading(false)}
                  onEnded={() => setPlaying(false)}
                  onError={() => setNoPlayer(true)}
                  onClick={togglePlay}
                />
              )}
              {noPlayer && !view && (
                <img
                  src={videoPreviewUrl(session.path, previewT)}
                  alt={t('{time} 的画面', { time: timeText(previewT) })}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              )}
              {view && (
                <>
                  <img
                    src={frameUrl(shownFile(view, original))}
                    alt={frameName(session.name, view.time)}
                    title={t('双击看大图')}
                    onDoubleClick={() => setZoomAt(frames.indexOf(view))}
                    className="absolute inset-0 h-full w-full cursor-zoom-in object-contain"
                  />
                  <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-2 py-1 text-footnote text-white">
                    <span>{view.source === 'manual' ? t('手动') : t('自动')}</span>
                    <span className="tabular-nums">{timeText(view.time)}</span>
                    <span>
                      {frames.indexOf(view) + 1}/{frames.length}
                    </span>
                    {view.enhanced && (
                      <span>{original ? t('原图') : t('增强：{name}', { name: view.enhanced.label })}</span>
                    )}
                  </div>
                  {view.enhanced && (
                    <button
                      type="button"
                      onClick={() => setOriginal((v) => !v)}
                      className="absolute top-2 right-2 cursor-pointer rounded-lg bg-black/60 px-2 py-1 text-footnote text-white hover:bg-black/75"
                    >
                      {original ? t('看增强') : t('看原图')}
                    </button>
                  )}
                </>
              )}
              {noPlayer && !view && (
                <div className="absolute bottom-2 left-2 rounded-lg bg-black/60 px-2 py-1 text-footnote text-white">
                  {t('浏览器放不了这个格式，拖动时间轴看画面')}
                </div>
              )}
            </div>

            <Transport
              playing={playing}
              loading={loading}
              sliding={sliding}
              noPlayer={noPlayer}
              hasFrames={frames.length > 0}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onPlay={togglePlay}
              onSlides={toggleSlides}
            />

            <Timeline
              cur={cur}
              duration={duration}
              frames={frames}
              viewId={viewId}
              onSeek={(v) => {
                setSliding(false)
                setViewId(null)
                seek(v)
              }}
              onFrame={showFrame}
            />

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button variant="primary" size="sm" disabled={busy} onClick={keyFrame} title={t('截取当前位置（K）')}>
                <Crosshair className="h-3.5 w-3.5" />
                {t('截取当前帧')}
              </Button>
              <span className="h-5 w-px bg-line" aria-hidden />
              <Segmented
                size="sm"
                label={t('自动截帧方式')}
                value={mode}
                onChange={setMode}
                options={[
                  { id: 'scene', label: t('画面变化') },
                  { id: 'screen', label: t('录屏') },
                  { id: 'uniform', label: t('均匀') },
                ]}
              />
              <select
                aria-label={t('自动截几帧')}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="h-8 rounded-lg border border-line-strong bg-field px-2 text-body text-fg"
              >
                {COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {t('{n} 帧', { n })}
                  </option>
                ))}
              </select>
              <Button variant="secondary" size="sm" disabled={busy} onClick={autoKey}>
                {work?.kind === 'auto' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <WandSparkles className="h-3.5 w-3.5" />
                )}
                {t('自动截帧')}
              </Button>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" disabled={busy || !manualCount} onClick={() => clear('manual')}>
                <Trash2 className="h-3.5 w-3.5" />
                {t('清除手动帧（{n}）', { n: manualCount })}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || !autoCount} onClick={() => clear('auto')}>
                {t('清除自动帧（{n}）', { n: autoCount })}
              </Button>
            </div>
            <p className="-mt-1 text-footnote text-subtle">
              {mode === 'scene'
                ? t('画面变化：在镜头切换、画面明显变了的地方截，适合剪辑过的视频和游戏实机。')
                : mode === 'screen'
                  ? t('录屏：跳过一动不动的画面，在操作发生的地方截，适合软件录屏。')
                  : t('均匀：按时长平均截。')}{' '}
              {t('每个时间点会在前后 0.25 秒里挑最清楚的一张；手动截的帧不受影响。')}
            </p>

            <FrameStrip
              frames={frames}
              viewId={viewId}
              skipped={skipped}
              original={original}
              working={working}
              onView={showFrame}
              onZoom={(f) => setZoomAt(frames.indexOf(f))}
              onToggle={(f) =>
                setSkipped((s) => {
                  const next = new Set(s)
                  if (next.has(f.id)) next.delete(f.id)
                  else next.add(f.id)
                  return next
                })
              }
              onRemove={removeOne}
            />

            <div
              className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2"
              data-surface=""
            >
              <Sparkles className="h-3.5 w-3.5 text-muted" />
              <span className="text-body text-fg">{t('画面增强')}</span>
              <select
                aria-label={t('增强方式')}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="h-8 max-w-[260px] min-w-0 rounded-lg border border-line-strong bg-field px-2 text-body text-fg"
              >
                {methods.map((m) => (
                  <option key={m.id} value={m.id} title={m.note}>
                    {m.label}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !chosen.length}
                onClick={enhance}
                title={!frames.length ? t('先截几帧再增强') : !chosen.length ? t('先勾选要处理的帧') : undefined}
              >
                {work?.kind === 'enhance' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('处理选中的帧（{n}）', { n: chosen.length })}
              </Button>
              {anyEnhanced && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={unenhance}>
                  {t('去掉增强')}
                </Button>
              )}
              <span className="min-w-0 flex-1 text-footnote text-subtle">
                {!frames.length
                  ? t('先截几帧，勾选的帧会按这个方式处理')
                  : `${methods.find((m) => m.id === method)?.note ?? ''} · ${t('增强会补出原来没有的细节，读文字、数字以原图为准')}`}
              </span>
            </div>
          </>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-(color:--modal-edge) px-5 py-3">
        {work ? (
          <WorkBar work={work} onCancel={() => stop.current?.abort()} />
        ) : (
          <span className="min-w-0 truncate text-footnote text-subtle">
            {t('发送时视频换成这些帧图片，视频本身不会被拷贝或改动')}
          </span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('取消')}
        </Button>
        <Button variant="primary" size="sm" disabled={!chosen.length || busy} onClick={insert}>
          {t('用这些帧（{n}）', { n: chosen.length })}
        </Button>
      </footer>
      <Lightbox images={zoomImages} index={zoomAt} onClose={() => setZoomAt(undefined)} />
    </div>
  )
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 py-16 text-body text-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
  )
}
