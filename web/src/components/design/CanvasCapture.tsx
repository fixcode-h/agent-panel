import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CaptureRequest } from '@shared/design'
import { t } from '@shared/i18n'
import { walk, type Widget } from '@shared/umg'
import { api } from '@/lib/api'
import { UmgNode, type RenderImage } from './umg-render'
import type { DesignData } from '@shared/design-data'

/** 整张截图最多等这么久：页面切走或者渲染卡住时不要一直挂着，AI 那边也只会等到超时 */
const CAPTURE_LIMIT = 15_000

/**
 * 后台标签页里 requestAnimationFrame 不跑，而 html-to-image 内部也靠它等图片渲染完。
 * 截图期间把 rAF 临时换成定时器，前台页面不受影响
 */
async function withFrameFallback<T>(fn: () => Promise<T>): Promise<T> {
  if (document.visibilityState !== 'hidden') return fn()
  const raf = window.requestAnimationFrame
  const caf = window.cancelAnimationFrame
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let seq = 0
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = ++seq
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        cb(performance.now())
      }, 16),
    )
    return id
  }
  window.cancelAnimationFrame = (id) => {
    const timer = timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(id)
  }
  try {
    return await fn()
  } finally {
    for (const timer of timers.values()) clearTimeout(timer)
    window.requestAnimationFrame = raf
    window.cancelAnimationFrame = caf
  }
}

function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(t('截图超时：设计页面在后台或者渲染卡住了，请重试'))), CAPTURE_LIMIT)
  })
  return Promise.race([fn(), limit]).finally(() => clearTimeout(timer))
}

/**
 * AI 要看画布的截图（设计工具的 screenshot）：在页面外按 1:1 画出这棵树，截成 PNG 交回服务端，
 * 连同每个控件的位置（设计稿像素），AI 拿来检查重叠、跑出画面等问题。画完一次就交回，不管成败
 */
export function CanvasCapture({
  designId,
  req,
  images,
  web,
  data,
  onDone,
}: {
  designId: string
  req: CaptureRequest
  images: Map<string, RenderImage>
  web: boolean
  /** 画板假数据：截图和用户看到的画板效果一致 */
  data?: DesignData
  onDone: (id: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const run = async () => {
      const el = box.current
      if (!el) throw new Error(t('画布没有画出来（页面可能正在切换），请重试'))
      let count = 0
      walk(req.root, () => count++)
      if (count <= 1) throw new Error(t('画布是空的：这棵树里还没有可截的控件，先搭好界面再截图'))
      const png = await withLimit(async () => {
        // 等字体和图片都到了再截，不然截出来是空白
        await document.fonts?.ready
        await Promise.all(
          [...el.querySelectorAll('img')].map((img) =>
            img.complete ? null : new Promise((r) => img.addEventListener('load', r, { once: true })),
          ),
        )
        return withFrameFallback(async () => {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          const { toPng } = await import('html-to-image')
          try {
            return await toPng(el, { width: req.size.X, height: req.size.Y, pixelRatio: 1 })
          } catch (e) {
            throw new Error(t('截图渲染失败：{error}', { error: (e as Error).message || t('未知错误') }))
          }
        })
      })
      const byId = new Map<string, Widget>()
      walk(req.root, (w) => byId.set(w.id, w))
      const base = el.getBoundingClientRect()
      const rects = [...el.querySelectorAll<HTMLElement>('[data-wid]')].flatMap((n) => {
        const w = byId.get(n.dataset.wid ?? '')
        if (!w) return []
        const r = n.getBoundingClientRect()
        return [{ name: w.Name, type: w.Type, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }]
      })
      await api.designCapture(designId, req.id, { data: png, rects })
    }
    // 截图失败也要把原因交回服务端，AI 才能说清楚是页面没打开、画布空还是渲染失败
    run()
      .catch((e) => api.designCapture(designId, req.id, { error: (e as Error).message }).catch(() => {}))
      .finally(() => onDone(req.id))
    // 每个截图请求只画一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [req.id])
  const ctx = {
    images,
    components: new Map(req.components.map((c) => [c.Name, c])),
    // 要 data-wid 才能量出每个控件的位置
    interactive: true,
    depth: 0,
    play: false,
    device: web ? ('desktop' as const) : undefined,
    data,
  }
  // 外层放在屏幕外面，截的是里面那层（它自己的位置是正常的，截出来不会偏）
  return createPortal(
    <div aria-hidden style={{ position: 'fixed', left: -100000, top: 0, pointerEvents: 'none' }}>
      <div
        ref={box}
        style={{
          width: req.size.X,
          height: req.size.Y,
          overflow: 'hidden',
          position: 'relative',
          background: '#0e0e10',
        }}
      >
        <UmgNode w={req.root} ctx={ctx} />
      </div>
    </div>,
    document.body,
  )
}
