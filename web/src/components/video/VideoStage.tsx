// 截帧弹窗的画面区（用户 2026-11-07 要的重新设计：画面尽量大，播放按钮和进度条像视频播放器一样浮在画面下方）。
// 看视频时显示播放器（或放不了的格式用 FFmpeg 取的画面）；看某一帧时显示那张帧，并在右上角浮出这一帧的工具：
// 原图 / 增强切换、增强前后对比滑块、标注、和前一张帧比哪里变了、看大图。
// 帧图片按 object-contain 的方式算出实际显示的矩形（fit），标注、变化框、对比滑块都叠在这个矩形里，才能和图片对齐。
import { useEffect, useRef, useState } from 'react'
import { Columns2, Maximize2, PenLine, ScanEye, X } from 'lucide-react'
import { timeText, type VideoFrame } from '@shared/video'
import { boxesToShapes, type DiffBox, type FrameShape } from '@shared/video-tools'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { frameUrl } from '@/lib/video-api'
import { Annotator, ShapesSvg } from './annotate'

/** 鼠标停下多久后藏起播放控制（只在播放或看帧时藏；暂停在视频上时一直显示） */
const IDLE_MS = 2500

/** 帧差的结果：和哪一张比的、变了的框 */
export interface DiffResult {
  id: string
  prev: { id: string; time: number } | null
  boxes: DiffBox[]
}

/** 图片按 object-contain 放进容器后实际占的矩形 */
function useFit(iw: number, ih: number) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const s = iw > 0 && ih > 0 ? Math.min(size.w / iw, size.h / ih) : 0
  const w = iw * s
  const h = ih * s
  return { box, fit: { left: (size.w - w) / 2, top: (size.h - h) / 2, width: w, height: h } }
}

const tool =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-footnote text-white/90 transition-colors hover:bg-white/15 hover:text-white aria-pressed:bg-white/20 aria-pressed:text-white'

export function VideoStage(p: {
  /** 播放器或预览图（看帧时藏起来，不卸载：播放位置要留着） */
  player: React.ReactNode
  /** 浮在下方的播放控制（PlayerBar） */
  bar: React.ReactNode
  /** 看帧时右下角的说明，比如浏览器放不了的提示 */
  note?: string
  view: VideoFrame | null
  index: number
  total: number
  name: string
  playing: boolean
  original: boolean
  onOriginal: (v: boolean) => void
  annotating: boolean
  onAnnotate: (on: boolean) => void
  onShapes: (shapes: FrameShape[]) => void
  diff: DiffResult | null
  onDiff: () => void
  onCloseDiff: () => void
  onZoom: () => void
}) {
  const { view } = p
  const { box, fit } = useFit(view?.width || 16, view?.height || 9)
  const [active, setActive] = useState(true)
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [compare, setCompare] = useState(false)
  const [split, setSplit] = useState(50)
  // 换了一帧：对比关掉（新的这张不一定有增强图）
  useEffect(() => setCompare(false), [view?.id])
  useEffect(() => () => clearTimeout(idle.current), [])
  const wake = () => {
    setActive(true)
    clearTimeout(idle.current)
    idle.current = setTimeout(() => setActive(false), IDLE_MS)
  }
  // 开始播放、换了一帧：先显示控制条，鼠标不动一会儿再藏。wake 每次渲染都是新的，只按播放状态和帧重排
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => wake(), [p.playing, view?.id])
  // 只在暂停看视频时一直显示；播放、看帧时鼠标不动就藏起来，画面不被挡
  const barShown = !p.annotating && (active || (!p.playing && !view))
  const shown = view ? (view.enhanced && !p.original ? view.enhanced.file : view.file) : ''
  const diff = view && p.diff?.id === view.id ? p.diff : null
  const comparing = compare && !!view?.enhanced && !p.annotating

  return (
    <div
      ref={box}
      className={cn('relative min-h-[240px] flex-1 overflow-hidden bg-black', !barShown && p.playing && 'cursor-none')}
      onMouseMove={wake}
      onMouseLeave={() => setActive(false)}
      data-surface=""
    >
      <div className={cn('absolute inset-0', view && 'invisible')}>{p.player}</div>

      {view && (
        <div className="absolute" style={fit}>
          {comparing ? (
            <Compare
              before={frameUrl(view.file)}
              after={frameUrl(view.enhanced!.file)}
              label={view.enhanced!.label}
              split={split}
              onSplit={setSplit}
            />
          ) : (
            <img
              src={frameUrl(shown)}
              alt={p.name}
              onDoubleClick={p.annotating ? undefined : p.onZoom}
              draggable={false}
              className="absolute inset-0 h-full w-full select-none"
            />
          )}
          {!p.annotating && (
            <ShapesSvg
              shapes={view.shapes ?? []}
              boxes={diff?.boxes}
              width={view.width || 1600}
              height={view.height || 900}
              className="pointer-events-none"
            />
          )}
          {p.annotating && (
            <Annotator
              initial={view.shapes ?? []}
              width={view.width || 1600}
              height={view.height || 900}
              onCancel={() => p.onAnnotate(false)}
              onDone={(s) => {
                p.onAnnotate(false)
                p.onShapes(s)
              }}
            />
          )}
        </div>
      )}

      {/* 左上：这是第几张、什么时候截的、显示的是哪一份 */}
      {view && !p.annotating && (
        <div className="absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-black/65 px-2.5 py-1.5 text-footnote text-white backdrop-blur-sm">
          <span className={cn('h-2 w-2 rounded-full', view.source === 'manual' ? 'bg-accent' : 'bg-white/70')} />
          <span>{view.source === 'manual' ? t('手动') : t('自动')}</span>
          <span className="font-mono tabular-nums">{timeText(view.time)}</span>
          <span className="text-white/60 tabular-nums">
            {p.index + 1}/{p.total}
          </span>
        </div>
      )}

      {/* 右上：这一帧的工具 */}
      {view && !p.annotating && (
        <div
          className="absolute top-3 right-3 flex items-center gap-0.5 rounded-xl bg-black/65 p-1 backdrop-blur-sm"
          role="toolbar"
          aria-label={t('这一帧的工具')}
        >
          {view.enhanced && (
            <>
              <div className="flex rounded-lg bg-white/10 p-0.5" role="group" aria-label={t('显示哪一份')}>
                {[
                  { on: p.original, label: t('原图'), v: true },
                  { on: !p.original, label: t('增强'), v: false },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    aria-pressed={o.on && !comparing}
                    onClick={() => {
                      setCompare(false)
                      p.onOriginal(o.v)
                    }}
                    title={o.v ? t('发送原图') : t('发送增强图：{name}', { name: view.enhanced!.label })}
                    className="h-7 cursor-pointer rounded-md px-2.5 text-footnote text-white/75 hover:text-white aria-pressed:bg-white aria-pressed:text-black"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={tool}
                aria-pressed={comparing}
                onClick={() => setCompare((v) => !v)}
                title={t('左右拖动对比增强前后')}
              >
                <Columns2 className="h-4 w-4" />
                {t('对比')}
              </button>
              <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden />
            </>
          )}
          <button
            type="button"
            className={tool}
            onClick={() => p.onAnnotate(true)}
            title={t('在这一帧上画框、箭头、写备注（发送时画进图里）')}
          >
            <PenLine className="h-4 w-4" />
            {view.shapes?.length ? t('标注（{n}）', { n: view.shapes.length }) : t('标注')}
          </button>
          <button
            type="button"
            className={tool}
            aria-pressed={!!diff}
            onClick={() => (diff ? p.onCloseDiff() : p.onDiff())}
            title={t('和时间上的前一张帧比，框出哪里变了')}
          >
            <ScanEye className="h-4 w-4" />
            {t('变化')}
          </button>
          <button
            type="button"
            className={cn(tool, 'px-2')}
            onClick={p.onZoom}
            title={t('看大图（双击画面也行）')}
            aria-label={t('看大图')}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 帧差的说明条：和哪张比、变了几处，可以一键加成标注 */}
      {view && diff && !p.annotating && (
        <div className="absolute top-16 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/75 py-1 pr-1 pl-3 text-footnote text-white backdrop-blur-sm">
          <span className="h-2.5 w-2.5 rounded-sm border-2 border-dashed border-[#facc15]" aria-hidden />
          {!diff.prev
            ? t('这是第一张，没有前一张可比')
            : diff.boxes.length
              ? t('和 {time} 那张相比，{n} 处变了', { time: timeText(diff.prev.time), n: diff.boxes.length })
              : t('和 {time} 那张相比几乎没变', { time: timeText(diff.prev.time) })}
          {diff.boxes.length > 0 && (
            <button
              type="button"
              onClick={() => {
                p.onShapes([...(view.shapes ?? []), ...boxesToShapes(diff.boxes)])
                p.onCloseDiff()
              }}
              className="h-6 cursor-pointer rounded-full bg-white px-2.5 font-medium text-black hover:opacity-90"
            >
              {t('标到图上')}
            </button>
          )}
          <button
            type="button"
            onClick={p.onCloseDiff}
            aria-label={t('关闭')}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded-full hover:bg-white/15"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {p.note && !view && (
        <div className="absolute top-3 left-3 rounded-lg bg-black/65 px-2.5 py-1.5 text-footnote text-white">
          {p.note}
        </div>
      )}

      {/* 下方浮着的播放控制：底下垫一层渐变，白字在亮画面上也看得清 */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent transition-opacity duration-200',
          barShown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onMouseMove={(e) => {
          // 鼠标在控制条上时一直显示
          e.stopPropagation()
          setActive(true)
          clearTimeout(idle.current)
        }}
      >
        {p.bar}
      </div>
    </div>
  )
}

/** 增强前后对比：左边原图、右边增强图，中间的竖线左右拖 */
function Compare({
  before,
  after,
  label,
  split,
  onSplit,
}: {
  before: string
  after: string
  label: string
  split: number
  onSplit: (v: number) => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const drag = useRef(false)
  const move = (x: number) => {
    const r = el.current?.getBoundingClientRect()
    if (r?.width) onSplit(Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100)))
  }
  return (
    <div
      ref={el}
      className="absolute inset-0 cursor-ew-resize touch-none select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = true
        move(e.clientX)
      }}
      onPointerMove={(e) => drag.current && move(e.clientX)}
      onPointerUp={() => (drag.current = false)}
      onPointerCancel={() => (drag.current = false)}
    >
      <img src={before} alt="" draggable={false} className="absolute inset-0 h-full w-full" />
      <img
        src={after}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full"
        style={{ clipPath: `inset(0 0 0 ${split}%)` }}
      />
      <div
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{ left: `${split}%` }}
      >
        <div
          role="slider"
          tabIndex={0}
          aria-label={t('对比位置')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(split)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0
            if (!d) return
            e.preventDefault()
            e.stopPropagation()
            onSplit(Math.min(100, Math.max(0, split + d)))
          }}
          className="absolute top-1/2 left-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-black shadow-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          <Columns2 className="h-4 w-4" />
        </div>
      </div>
      <span className="pointer-events-none absolute top-14 left-3 rounded-md bg-black/70 px-2 py-0.5 text-micro text-white">
        {t('原图')}
      </span>
      <span className="pointer-events-none absolute top-14 right-3 rounded-md bg-black/70 px-2 py-0.5 text-micro text-white">
        {t('增强：{name}', { name: label })}
      </span>
    </div>
  )
}
