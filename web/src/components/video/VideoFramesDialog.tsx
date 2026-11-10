// 视频截帧弹窗：点输入框里的视频卡片打开（用户 2026-11-05 定的：不把视频发给 Agent，发截出来的帧图片）。
// 2026-11-07 按用户要求重新设计：左边是画面（占满），播放按钮和进度条像视频播放器一样浮在画面下方，下面一行是截下来的帧；
// 右栏放截帧范围（可以记几段命名范围）、自动截帧（含去掉相似帧）、画面增强。看某一帧时画面右上角浮出这一帧的工具：
// 原图 / 增强、增强前后对比、标注（框 · 箭头 · 备注，发送时画进图里）、和前一张比哪里变了、看大图。
// 范围和弹窗设置记在服务端（server/video/frame-tools.ts），重新打开还在。手动截的帧自动截帧时一直保留。
// 原视频只读：播放走 /api/video/stream，截帧、增强都在服务端用 FFmpeg 写到数据目录（server/video/）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Film, Loader2, X } from 'lucide-react'
import type { Attachment } from '@shared/schema'
import {
  FFMPEG_ENHANCE,
  RANGE_MIN,
  browserPlayable,
  frameName,
  timeText,
  type AutoMode,
  type EnhanceMethod,
  type FfmpegStatus,
  type VideoFrame,
  type VideoRange,
  type VideoSession,
} from '@shared/video'
import type { FrameShape, NamedRange } from '@shared/video-tools'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { frameUrl, videoApi, videoPreviewUrl, videoStreamUrl } from '@/lib/video-api'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Lightbox } from '@/components/ui/lightbox'
import { FfmpegSetup } from './FfmpegSetup'
import { FrameStrip, IDLE, type Working } from './FrameStrip'
import { EnhanceBar } from './EnhanceBar'
import { PlayerBar } from './VideoControls'
import { SidePanel, rangeFrom } from './SidePanel'
import { VideoStage, type DiffResult } from './VideoStage'
import { renderAnnotated } from './annotate'
import { WorkBar, type Work } from './WorkBar'

/** 要截帧的视频：本机绝对路径；chosen 是上次选好的帧（再打开时照着勾上） */
export interface VideoTarget {
  path: string
  name: string
  chosen?: Attachment[]
}

/** 帧播放每张停多久 */
const SLIDE_MS = 800
/** 范围、设置改完多久存一次（拖把手时不每一下都存） */
const META_MS = 600

/** 这张帧现在显示 / 发送哪一份底图：有增强图且没切回原图时用增强图 */
const shownFile = (f: VideoFrame, original: boolean) => (f.enhanced && !original ? f.enhanced.file : f.file)
/** 画好的标注图还对得上现在的底图吗（底图换了要重画） */
const annotatedOk = (f: VideoFrame, original: boolean) =>
  !!f.shapes?.length && f.annotated?.from === shownFile(f, original)

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
  /** 记下来的命名范围和选中的那段（空是整段）：自动截帧只在选中的那段里分析、截图 */
  const [ranges, setRanges] = useState<NamedRange[]>([])
  const [active, setActive] = useState('')
  /** 正在给当前这一帧画标注 */
  const [annotating, setAnnotating] = useState(false)
  /** 帧差：当前这一帧和前一张比哪里变了 */
  const [diff, setDiff] = useState<DiffResult | null>(null)
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
  const range: VideoRange | null = ranges.find((r) => r.id === active) ?? null

  /** 增强方式（内置 ComfyUI 工作流缺不缺模型由服务端算；模型下完再拉一次） */
  const loadMethods = async () => setMethods((await videoApi.methods()).methods)
  // 先看有没有 FFmpeg，有了再打开视频（探测时长、读回之前截过的帧、记下的范围和设置）
  const chosen0 = useRef(target.chosen ?? [])
  /** 读回设置之后才开始存：不然刚打开时的默认值会先把记下的设置盖掉 */
  const ready = useRef(false)
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
          new Set(
            opened.frames
              .filter((f) => ![f.file, f.enhanced?.file, f.annotated?.file].some((p) => p && had.has(p)))
              .map((f) => f.id),
          ),
        )
      setRanges(opened.ranges)
      setActive(opened.ranges.some((r) => r.id === opened.prefs.range) ? opened.prefs.range : '')
      setMode(opened.prefs.mode)
      setCount(opened.prefs.count)
      if (opened.prefs.method) setMethod(opened.prefs.method)
      setSession(opened)
      ready.current = true
      await loadMethods()
    } catch (e) {
      setError((e as Error).message)
    }
    // loadMethods 只调接口、不读状态，不放进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
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
  // 范围和设置变了就记下（停一会儿再存）；存失败不打扰，下次改动再存
  const key = session?.key
  const vpath = session?.path
  useEffect(() => {
    if (!ready.current || !key || !vpath) return
    const id = setTimeout(() => {
      void videoApi
        .meta({ key, path: vpath }, { ranges, prefs: { mode, count, method, range: active } })
        .catch(() => {})
    }, META_MS)
    return () => clearTimeout(id)
  }, [ranges, active, mode, count, method, key, vpath])

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
  /** 跑的时候每 400ms 拉一次服务端的进度，写进 work（自动截帧、批量增强都用它） */
  const polling = (k: string, signal: AbortSignal) => {
    const id = setInterval(() => {
      void videoApi
        .progress(k)
        .then(
          (r) =>
            !signal.aborted &&
            setWork((w) => (w && (w.kind === 'auto' || w.kind === 'enhance') ? { ...w, progress: r.progress } : w)),
        )
        .catch(() => {})
    }, 400)
    return () => clearInterval(id)
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
    setAnnotating(false)
    setViewId(f.id)
    seek(f.time)
  }
  const togglePlay = () => {
    setSliding(false)
    setAnnotating(false)
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
    setAnnotating(false)
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
  /** 截帧、清除之后当前看的那张没了：回到视频 */
  const keepView = (s: VideoSession | undefined) => {
    if (s && view && !s.frames.some((f) => f.id === view.id)) setViewId(null)
  }
  /** 自动截帧：服务端先分析选中那段的画面再一张张截，等结果时轮询进度画进度条 */
  const autoKey = () => {
    if (!ref) return
    void run({ kind: 'auto', progress: null }, async (signal) => {
      const done = polling(ref.key, signal)
      try {
        return await videoApi.auto(ref, mode, count, range, signal)
      } finally {
        done()
      }
    }).then(keepView)
  }
  const clear = (which: 'manual' | 'auto') =>
    ref && void run({ kind: 'clear' }, () => videoApi.remove(ref, { which })).then(keepView)
  const removeOne = (f: VideoFrame) => {
    if (!ref) return
    if (viewId === f.id) setViewId(null)
    void run({ kind: 'clear' }, () => videoApi.remove(ref, { ids: [f.id] }))
  }
  /** 去掉几乎一样的自动帧：每组留最清楚的一张，手动帧不动 */
  const dedupe = () =>
    ref &&
    void run({ kind: 'clear' }, async () => {
      const r = await videoApi.dedupe(ref)
      toast.success(r.removed ? t('去掉了 {n} 张相似的帧', { n: r.removed }) : t('没有几乎一样的帧'))
      return r.session
    }).then(keepView)
  const chosen = frames.filter((f) => !skipped.has(f.id))
  /** 增强选中的帧：一次交给服务端（ComfyUI 那边一起排队、FFmpeg 几张并行），轮询进度标出哪几张在做、哪几张做完 */
  const enhance = () => {
    if (!ref) return
    const ids = chosen.map((f) => f.id)
    if (!ids.length) return toast.error(t('先勾选要处理的帧'))
    // 处理完默认看增强后的效果
    setOriginal(false)
    void run({ kind: 'enhance', ids, progress: null }, async (signal) => {
      const done = polling(ref.key, signal)
      try {
        return await videoApi.enhance(ref, ids, method, signal)
      } finally {
        done()
      }
    })
  }
  const unenhance = () => ref && void run({ kind: 'clear' }, () => videoApi.unenhance(ref))

  /** 存标注，并马上按现在显示的底图画好标注图（发送时就不用等） */
  const saveShapes = (shapes: FrameShape[]) => {
    if (!ref || !view) return
    const id = view.id
    void run({ kind: 'clear' }, async () => {
      let s = await videoApi.shapes(ref, id, shapes)
      const f = s.frames.find((x) => x.id === id)
      if (f && shapes.length) {
        const base = shownFile(f, original)
        s = await videoApi.annotated(ref, id, base, await renderAnnotated(frameUrl(base), shapes))
      }
      return s
    })
  }
  const runDiff = () => {
    if (!ref || !view) return
    const id = view.id
    videoApi
      .diff(ref, id)
      .then((r) => setDiff({ id, ...r }))
      .catch((e: Error) => toast.error(e.message))
  }

  /** 当前位置：播放器能放时以播放器为准（播放中 cur 只在 timeupdate 时更新，会慢一拍） */
  const nowAt = () => (video.current && !noPlayer ? video.current.currentTime : cur)
  /** 改选中的那段范围 */
  const editRange = (r: VideoRange) =>
    setRanges((list) => list.map((x) => (x.id === active ? { ...x, start: r.start, end: r.end } : x)))
  /** 设起点 / 终点：没选范围时新建一段（另一端取整段的头尾）；设反了（起点在终点后）就把另一端放回头尾 */
  const setEdge = (edge: 'in' | 'out') => {
    const at = nowAt()
    const next =
      edge === 'in'
        ? { start: at, end: range && range.end - at >= RANGE_MIN ? range.end : duration }
        : { start: range && at - range.start >= RANGE_MIN ? range.start : 0, end: at }
    if (next.end - next.start < RANGE_MIN) return
    if (range) return editRange(next)
    const r = { ...rangeFrom(next.start, duration), ...next }
    setRanges((list) => [...list, r])
    setActive(r.id)
  }

  // 键盘：空格播放 / 暂停，K 截取当前帧，← → 上一帧 / 下一帧，I / O 设截帧范围的起点 / 终点
  // （在输入框、下拉里打字、看大图、画标注时不接）
  const keys = useRef({ togglePlay, keyFrame, step, setEdge })
  keys.current = { togglePlay, keyFrame, step, setEdge }
  const pauseKeys = useRef(false)
  pauseKeys.current = zoomAt !== undefined || annotating
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (pauseKeys.current) return
      if (el?.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ') keys.current.togglePlay()
      else if (e.key === 'k' || e.key === 'K') keys.current.keyFrame()
      else if (e.key === 'ArrowLeft') keys.current.step(-1)
      else if (e.key === 'ArrowRight') keys.current.step(1)
      else if (e.key === 'i' || e.key === 'I') keys.current.setEdge('in')
      else if (e.key === 'o' || e.key === 'O') keys.current.setEdge('out')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  /**
   * 发给 Agent 时每张帧的附件：画了标注的发标注图，增强过的发增强图；
   * 同一时刻截了两次的名字加序号，输入框和消息里的卡片才分得清
   */
  const attachmentsOf = (s: VideoSession, ids: string[]): Attachment[] => {
    const taken = new Set<string>()
    return s.frames
      .filter((f) => ids.includes(f.id))
      .map((f) => {
        const enh = !!f.enhanced && !original
        const ann = annotatedOk(f, original)
        const base = frameName(s.name, f.time, enh, ann)
        let name = base
        for (let i = 2; taken.has(name); i++) name = base.replace(/\.png$/, ` (${i}).png`)
        taken.add(name)
        const file = ann ? f.annotated! : enh ? f.enhanced! : f
        return { name, path: file.file, size: file.bytes ?? 0, mime: 'image/png' }
      })
  }
  // 附件不限个数：选中的帧全部记到视频卡片上。画了标注、但标注图和现在的底图对不上（换过原图 / 增强）的先重画
  const insert = () => {
    if (!session || !ref || !chosen.length) return
    const ids = chosen.map((f) => f.id)
    void run({ kind: 'clear' }, async () => {
      let s = session
      for (const id of ids) {
        const f = s.frames.find((x) => x.id === id)
        if (!f?.shapes?.length || annotatedOk(f, original)) continue
        const base = shownFile(f, original)
        s = await videoApi.annotated(ref, id, base, await renderAnnotated(frameUrl(base), f.shapes))
      }
      onInsert(attachmentsOf(s, ids))
      onClose()
      return undefined
    })
  }
  const manualCount = frames.filter((f) => f.source === 'manual').length
  const autoCount = frames.length - manualCount
  const anyEnhanced = frames.some((f) => f.enhanced)
  const zoomImages = useMemo(
    () =>
      session
        ? frames.map((f) => ({
            src: frameUrl(annotatedOk(f, original) ? f.annotated!.file : shownFile(f, original)),
            name: frameName(session.name, f.time),
          }))
        : [],
    [frames, original, session],
  )
  const working: Working = useMemo(() => {
    if (work?.kind !== 'enhance') return IDLE
    const p = work.progress?.stage === 'enhance' ? work.progress : null
    const running = new Set(p?.running ?? [])
    const finished = new Set(p?.finished ?? [])
    return { running, finished, queued: new Set(work.ids.filter((id) => !running.has(id) && !finished.has(id))) }
  }, [work])

  const player = !session ? null : noPlayer ? (
    <img
      src={videoPreviewUrl(session.path, previewT)}
      alt={t('{time} 的画面', { time: timeText(previewT) })}
      className="absolute inset-0 h-full w-full object-contain"
    />
  ) : (
    <video
      ref={video}
      src={videoStreamUrl(session.path)}
      preload="metadata"
      playsInline
      className="absolute inset-0 h-full w-full object-contain"
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
  )

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
        <span className="hidden text-micro text-subtle lg:inline">
          {t('空格 播放 · K 截帧 · ← → 上一帧 / 下一帧 · I / O 范围起点 / 终点')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('关闭')}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {error ? (
        <div className="p-5">
          <div
            className="flex flex-col items-start gap-2 rounded-xl bg-danger/8 p-4 text-body text-danger"
            data-surface=""
          >
            {error}
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t('重试')}
            </Button>
          </div>
        </div>
      ) : !status ? (
        <Loading text={t('正在检查 FFmpeg')} />
      ) : !status.path ? (
        <div className="overflow-y-auto px-5 py-4">
          <FfmpegSetup status={status} onStatus={setStatus} />
        </div>
      ) : !session ? (
        <Loading text={t('正在读取视频')} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <VideoStage
              player={player}
              note={noPlayer ? t('浏览器放不了这个格式，拖动进度条看画面') : undefined}
              view={view}
              index={view ? frames.indexOf(view) : 0}
              total={frames.length}
              name={view ? frameName(session.name, view.time) : session.name}
              playing={playing}
              original={original}
              onOriginal={setOriginal}
              annotating={annotating}
              onAnnotate={setAnnotating}
              onShapes={saveShapes}
              diff={diff}
              onDiff={runDiff}
              onCloseDiff={() => setDiff(null)}
              onZoom={() => view && setZoomAt(frames.indexOf(view))}
              bar={
                <PlayerBar
                  cur={cur}
                  duration={duration}
                  frames={frames}
                  viewId={viewId}
                  range={range}
                  playing={playing}
                  loading={loading}
                  sliding={sliding}
                  noPlayer={noPlayer}
                  busy={busy}
                  onSeek={(v) => {
                    setSliding(false)
                    setAnnotating(false)
                    setViewId(null)
                    seek(v)
                  }}
                  onFrame={showFrame}
                  onRange={editRange}
                  onPrev={() => step(-1)}
                  onNext={() => step(1)}
                  onPlay={togglePlay}
                  onSlides={toggleSlides}
                  onSetIn={() => setEdge('in')}
                  onSetOut={() => setEdge('out')}
                  onClearRange={() => setActive('')}
                  onCapture={keyFrame}
                />
              }
            />
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
              onAll={(on) => setSkipped(on ? new Set() : new Set(frames.map((f) => f.id)))}
              onRemove={removeOne}
            />
          </div>
          <SidePanel
            duration={duration}
            cur={cur}
            busy={busy}
            ranges={ranges}
            active={active}
            onActive={setActive}
            onRanges={setRanges}
            mode={mode}
            count={count}
            onMode={setMode}
            onCount={setCount}
            autoRunning={work?.kind === 'auto'}
            onAuto={autoKey}
            onDedupe={dedupe}
            manualCount={manualCount}
            autoCount={autoCount}
            onClear={clear}
            enhance={
              <EnhanceBar
                methods={methods}
                method={method}
                onMethod={setMethod}
                busy={busy}
                running={work?.kind === 'enhance'}
                frames={frames.length}
                chosen={chosen.length}
                anyEnhanced={anyEnhanced}
                onEnhance={enhance}
                onUnenhance={unenhance}
                onReload={() => void loadMethods().catch(() => {})}
              />
            }
          />
        </div>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-(color:--modal-edge) px-4 py-2.5">
        {work ? (
          <WorkBar work={work} onCancel={() => stop.current?.abort()} />
        ) : (
          <span className="min-w-0 truncate text-footnote text-subtle">
            {t('发送时视频换成这些帧图片（画了标注的发标注图），视频本身不会被拷贝或改动')}
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
