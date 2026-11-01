import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { openAiFix } from '@/lib/ai-fix'
import { MB, fmtMem } from '@/lib/mem'
import { cn } from '@/lib/utils'
import { t, uiLocale } from '@shared/i18n'
import { TASK_MEMORY_TOPIC } from '@shared/memory-analysis'
import type { MemoryPoint } from '@shared/schema'

/**
 * 会话内存曲线：自己用 SVG 画（不引图表库），横轴时间、纵轴内存。
 * 显示的点数按容器宽度算（窄窗口自动少显示几个），左右拖动看更早的采样（左右键都行）；
 * 悬停显示那个点的时间和数值。取不到的点（系统进程表读不到）断开，不画成 0。
 * 底部「AI 分析」把整段采样交给本机 CLI 体检（见 shared/memory-analysis.ts），结论在弹窗里聊
 */
const HEIGHT = 150
const PAD = { left: 8, right: 8, top: 10, bottom: 20 }
/** 每个点占的宽度：太密就拖动起来看不清，太疏又看不出趋势 */
const PX_PER_POINT = 3
/** 和采样间隔一致：30 秒刷一次，刚好接上新点 */
const REFRESH_MS = 30_000

/** 上一次「AI 分析」的时间和数据摘要：按对话记在本地，下次打开面板知道什么时候分析过 */
type LastAnalysis = { at: number; trendText: string }
const analysisKey = (taskId: string) => `agent-panel:memory-analysis:${taskId}`

function readAnalysis(taskId: string): LastAnalysis | null {
  try {
    const raw = JSON.parse(localStorage.getItem(analysisKey(taskId)) ?? 'null') as LastAnalysis | null
    return raw && Number.isFinite(raw.at) && raw.trendText ? raw : null
  } catch {
    return null
  }
}

function timeLabel(t: number) {
  const d = new Date(t)
  return d.toLocaleTimeString(uiLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function dayLabel(t: number) {
  const d = new Date(t)
  return d.toLocaleDateString(uiLocale(), { month: 'numeric', day: 'numeric' })
}

/** 跨天的带上日期，不然「上次分析 09:12」看不出是哪天 */
const whenLabel = (t: number) =>
  new Date(t).toDateString() === new Date().toDateString() ? timeLabel(t) : `${dayLabel(t)} ${timeLabel(t)}`

export function MemoryChart({ taskId }: { taskId: string }) {
  const [points, setPoints] = useState<MemoryPoint[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [width, setWidth] = useState(360)
  /** 从最新一点往回跳过多少个点：拖动看历史时变大 */
  const [offset, setOffset] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  /** 最近一次 AI 分析（时间 + 当时的趋势摘要），结论本身在弹窗里 */
  const [analysis, setAnalysis] = useState<LastAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [aiError, setAiError] = useState('')
  const box = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; offset: number } | null>(null)

  useEffect(() => setAnalysis(readAnalysis(taskId)), [taskId])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api.taskMemory(taskId)
        if (!alive) return
        setPoints(d.points)
        setError('')
      } catch (e) {
        if (alive) setError((e as Error).message)
      } finally {
        if (alive) setLoaded(true)
      }
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [taskId])

  // 宽度跟着面板走：窄窗口时少显示几个点，不出现横向滚动
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setWidth(Math.max(180, el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const plotW = Math.max(1, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const visible = Math.max(12, Math.min(points.length || 0, Math.floor(plotW / PX_PER_POINT)))
  const end = Math.max(0, points.length - offset)
  const start = Math.max(0, end - visible)
  const slice = points.slice(start, end)
  const stepX = slice.length > 1 ? plotW / (slice.length - 1) : 0
  // 纵轴取全部点的最大值并向上取整到 256 MB：拖动时比例不变，曲线不会跳
  const maxV = points.reduce((m, p) => Math.max(m, p.total ?? 0), 0)
  const top = Math.max(MB, Math.ceil(maxV / (256 * MB)) * 256 * MB)

  const xOf = (i: number) => PAD.left + (slice.length > 1 ? i * stepX : plotW / 2)
  const yOf = (v: number) => PAD.top + plotH - Math.min(1, v / top) * plotH

  // 连续的非空点各画一段：中间缺采样（取不到系统信息）的地方断开
  const segs: [number, number][][] = []
  let cur: [number, number][] = []
  slice.forEach((p, i) => {
    if (p.total === null) {
      if (cur.length) segs.push(cur)
      cur = []
      return
    }
    cur.push([xOf(i), yOf(p.total)])
  })
  if (cur.length) segs.push(cur)

  const latest = points[points.length - 1]
  const shown = hover !== null ? slice[hover] : slice[slice.length - 1]

  const clampOffset = (v: number) => Math.max(0, Math.min(Math.max(0, points.length - visible), v))

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // 左右键都能拖动（右键不弹浏览器菜单）：看历史是常用操作，不该只认左键
    if (e.button !== 0 && e.button !== 2) return
    if (points.length <= visible) return
    drag.current = { x: e.clientX, offset }
    e.currentTarget.setPointerCapture(e.pointerId)
    // 右键按下时浏览器会选中文字、准备弹菜单，都要拦掉
    e.preventDefault()
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (d) {
      // 往右拖 = 看更早：offset 变大
      setOffset(clampOffset(stepX ? d.offset + (e.clientX - d.x) / stepX : d.offset))
      return
    }
    if (!stepX) return
    const rect = e.currentTarget.getBoundingClientRect()
    const i = Math.round((e.clientX - rect.left - PAD.left) / stepX)
    setHover(i >= 0 && i < slice.length ? i : null)
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const tick = (i: number) => {
    const p = slice[i]
    if (!p) return null
    // 跨天的采样点在刻度上带上日期，不然看不出是哪天的
    return new Date(p.t).toDateString() === new Date(latest?.t ?? p.t).toDateString()
      ? timeLabel(p.t)
      : `${dayLabel(p.t)} ${timeLabel(p.t)}`
  }
  const tickIdx = slice.length
    ? [...new Set([0, Math.floor((slice.length - 1) / 3), Math.floor(((slice.length - 1) * 2) / 3), slice.length - 1])]
    : []

  /**
   * 交给 AI 体检：现算报告（采样序列 + 进程两路 + 任务树规模），在统一的排查弹窗里聊。
   * 只记下这次分析的时间和趋势摘要，结论本身不在这里重复显示（弹窗里就是完整结论）
   */
  const analyze = async () => {
    if (analyzing) return
    setAnalyzing(true)
    setAiError('')
    try {
      const [d, task] = await Promise.all([api.taskMemoryAnalysis(taskId), api.task(taskId)])
      const last = { at: d.sampledAt, trendText: d.trendText }
      try {
        localStorage.setItem(analysisKey(taskId), JSON.stringify(last))
      } catch {
        // 本地存储写不进去（隐私模式、空间满）：这次照常分析，只是下次打开看不到记录
      }
      setAnalysis(last)
      openAiFix({
        title: t('会话内存分析'),
        topic: TASK_MEMORY_TOPIC,
        ask: d.ask,
        context: d.report,
        // 相关目录给项目路径：AI 要能按路径去看源码给方案
        cwd: d.cwd,
        // 会话的内存分析属于这个对话：按归属规则开在项目里或它所属的顶层对话下
        home: { kind: 'task', task },
      })
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <div className="px-3 py-2" ref={box}>
      <div className="flex items-baseline justify-between gap-2 text-footnote">
        <span className="text-muted">{t('内存合计')}</span>
        <span className="font-medium tabular-nums">{fmtMem(shown?.cli ?? null)}</span>
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-caption text-subtle">
        <span>{t('进程 {v}', { v: fmtMem(shown?.cli ?? null) })}</span>
        <span>{t('面板 {v}（不计入）', { v: fmtMem(shown?.server ?? null) })}</span>
        {shown && <span className="tabular-nums">{timeLabel(shown.t)}</span>}
      </p>

      {error && <p className="mt-1 text-caption text-danger">{error}</p>}
      {aiError && <p className="mt-1 text-caption text-danger">{t('内存分析没成功：{msg}', { msg: aiError })}</p>}

      <div className="relative mt-1">
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={t('会话内存随时间的变化')}
          className={cn('block touch-none select-none', points.length > visible ? 'cursor-grab' : 'cursor-default')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (!drag.current) setHover(null)
          }}
          // 右键拖动时不要弹浏览器菜单
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* 横线：0、一半、顶，给个数量级参考 */}
          {[0, 0.5, 1].map((r) => (
            <line
              key={r}
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={PAD.top + plotH * (1 - r)}
              y2={PAD.top + plotH * (1 - r)}
              className="stroke-line"
              strokeDasharray={r === 0 ? undefined : '3 3'}
            />
          ))}
          {[0.5, 1].map((r) => (
            <text key={r} x={PAD.left + 2} y={PAD.top + plotH * (1 - r) - 3} className="fill-subtle text-micro">
              {fmtMem(top * r)}
            </text>
          ))}

          {segs.map((seg, i) => (
            <polyline
              key={i}
              points={seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
              fill="none"
              strokeWidth={1.6}
              strokeLinecap="round"
              className="stroke-accent"
            />
          ))}

          {/* 悬停的竖线和点 */}
          {hover !== null && slice[hover]?.total !== null && slice[hover] && (
            <>
              <line
                x1={xOf(hover)}
                x2={xOf(hover)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                className="stroke-muted"
                strokeDasharray="3 3"
              />
              <circle cx={xOf(hover)} cy={yOf(slice[hover].total!)} r={2.6} className="fill-accent" />
            </>
          )}

          {tickIdx.map((i) => (
            <text key={i} x={xOf(i)} y={HEIGHT - 6} textAnchor="middle" className="fill-subtle text-micro">
              {tick(i)}
            </text>
          ))}
        </svg>

        {loaded && !points.length && (
          <p className="absolute inset-0 flex items-center justify-center text-footnote text-subtle">
            {t('还没有内存采样，30 秒后开始记录')}
          </p>
        )}
      </div>

      <div className="mt-0.5 flex items-center justify-between gap-2 text-caption text-subtle">
        <span className="flex flex-wrap items-center gap-x-2">
          <span>{t('每 {s} 秒采样一次', { s: 30 })}</span>
          {offset > 0 ? (
            <Button variant="link" onClick={() => setOffset(0)}>
              {t('回到最新')}
            </Button>
          ) : (
            points.length > visible && <span>{t('左右拖动查看更早')}</span>
          )}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 shrink-0 px-2"
          disabled={analyzing || !loaded}
          title={t('把这个会话的内存采样和进程占用交给 AI，看有没有问题、怎么优化')}
          onClick={() => void analyze()}
        >
          {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 分析')}
        </Button>
      </div>
      {analysis && (
        <button
          type="button"
          className="mt-0.5 w-full cursor-pointer truncate text-left text-caption text-subtle hover:text-muted disabled:cursor-default"
          disabled={analyzing}
          title={t('重新分析并打开这次排查')}
          onClick={() => void analyze()}
        >
          {t('上次分析 {time}：{trend}', { time: whenLabel(analysis.at), trend: analysis.trendText })}
        </button>
      )}
    </div>
  )
}
