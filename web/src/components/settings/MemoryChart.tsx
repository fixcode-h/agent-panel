import { useEffect, useRef, useState } from 'react'
import type { MemorySample } from '@shared/data'
import { chartWindow, formatBytes, formatSampleTime, panEndMs } from '@shared/memory'
import { t } from '@shared/i18n'

/** 曲线默认看最近一小时：采样保留两小时，右键拖动可以往前看 */
export const CHART_WINDOW_MS = 60 * 60_000

// 绘图坐标：固定 1000 x 200 的 viewBox，随容器缩放；拖拽时再按实际像素换算
const W = 1000
const H = 200
const PAD = 8

/** 纵轴上界取整到好读的刻度，免得曲线一直贴着顶 */
function niceMax(v: number) {
  const mb = v / 1024 / 1024
  const step = mb <= 128 ? 32 : mb <= 512 ? 128 : mb <= 2048 ? 512 : 2048
  return Math.max(64, Math.ceil(mb / step) * step) * 1024 * 1024
}
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))

/**
 * 面板进程和子进程的内存曲线（设置 →「数据」）。
 * 数据全部来自服务端定时采样：这里只负责画和拖动时间窗口，不会自己造点。
 * 右键按住左右拖动平移时间轴（看更早的采样），拖回最右边或点「回到最新」恢复跟随。
 */
export function MemoryChart({ samples }: { samples: MemorySample[] }) {
  const latest = samples.length ? Date.parse(samples[samples.length - 1].at) : Date.now()
  const earliest = samples.length ? Date.parse(samples[0].at) : latest
  const [endMs, setEndMs] = useState(latest)
  const [follow, setFollow] = useState(true)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; end: number; width: number } | null>(null)

  // 跟随最新：来了新采样就把窗口右端挪到最新；用户拖走在看历史时不打扰
  useEffect(() => {
    if (follow) setEndMs(latest)
  }, [latest, follow])

  const win = chartWindow(samples, endMs, CHART_WINDOW_MS)
  const values = win.points.flatMap((p) => [p.rss, p.child]).filter((v): v is number => v !== null)
  const max = niceMax(values.length ? Math.max(...values) : 0)
  const x = (at: string) => clamp(((Date.parse(at) - win.from) / CHART_WINDOW_MS) * W, 0, W)
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2)
  // 一条线按采样顺序连起来；中间有「未采集」（null）就断开，不拿 0 顶上
  const lines = (pick: (p: MemorySample) => number | null) => {
    const out: string[] = []
    let cur: string[] = []
    for (const p of win.points) {
      const v = pick(p)
      if (v === null) {
        if (cur.length > 1) out.push(cur.join(' '))
        cur = []
        continue
      }
      cur.push(`${x(p.at).toFixed(1)},${y(v).toFixed(1)}`)
    }
    if (cur.length > 1) out.push(cur.join(' '))
    return out
  }
  const panelLines = lines((p) => p.rss)
  const childLines = lines((p) => p.child)
  const last = win.points[win.points.length - 1]
  const hasChild = win.points.some((p) => p.child !== null)

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 2) return
    const rect = svg.current?.getBoundingClientRect()
    if (!rect) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, end: endMs, width: rect.width }
  }
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const next = panEndMs({
      endMs: d.end,
      dxPx: e.clientX - d.x,
      widthPx: d.width,
      windowMs: CHART_WINDOW_MS,
      earliestMs: earliest,
      latestMs: latest,
    })
    setEndMs(next)
    setFollow(next >= latest - 1000)
  }
  const onUp = () => {
    drag.current = null
  }

  if (samples.length < 2)
    return <p className="rounded-xl border bg-field/40 px-3.5 py-6 text-center text-xs text-subtle">{t('正在采样…')}</p>

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3 text-xs text-subtle">
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 rounded-full bg-accent" />
          {t('面板')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 rounded-full bg-focus" />
          {t('进程')}
          {!hasChild && <span className="text-warning">{t('未采集')}</span>}
        </span>
        <span className="ml-auto text-[0.6875rem]">
          {earliest < latest - CHART_WINDOW_MS
            ? t('按住右键左右拖动查看更早的采样')
            : t('采样还在积累，够一小时就能往前看')}
        </span>
        {!follow && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="cursor-pointer rounded-md border px-1.5 py-0.5 text-[0.6875rem] text-muted transition-colors hover:bg-sel"
          >
            {t('回到最新')}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border bg-field/40">
        <svg
          ref={svg}
          role="img"
          aria-label={t('面板进程和子进程的内存曲线')}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-[168px] w-full touch-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {[0, 1, 2].map((i) => (
            <line
              key={i}
              x1={0}
              x2={W}
              y1={y((max / 3) * (i + 1))}
              y2={y((max / 3) * (i + 1))}
              stroke="var(--line)"
              strokeWidth={1}
              strokeDasharray="3 5"
            />
          ))}
          {panelLines.map((p, i) => (
            <polyline
              key={`p${i}`}
              points={p}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.6}
              strokeLinejoin="round"
            />
          ))}
          {childLines.map((p, i) => (
            <polyline
              key={`c${i}`}
              points={p}
              fill="none"
              stroke="var(--focus)"
              strokeWidth={1.6}
              strokeLinejoin="round"
            />
          ))}
          {last && (
            <>
              <circle cx={x(last.at)} cy={y(last.rss)} r={3} fill="var(--accent)" />
              {last.child !== null && <circle cx={x(last.at)} cy={y(last.child)} r={3} fill="var(--focus)" />}
            </>
          )}
          <text x={4} y={14} className="fill-subtle" fontSize={13}>
            {formatBytes(max)}
          </text>
        </svg>
      </div>
      <div className="flex justify-between font-mono text-[0.6875rem] text-subtle">
        <span>{formatSampleTime(new Date(win.from).toISOString())}</span>
        <span>{formatSampleTime(new Date(win.to).toISOString())}</span>
      </div>
    </div>
  )
}
