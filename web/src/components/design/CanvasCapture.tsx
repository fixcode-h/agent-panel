import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CaptureRequest } from '@shared/design'
import { walk, type Widget } from '@shared/umg'
import { api } from '@/lib/api'
import { UmgNode, type RenderImage } from './umg-render'

/**
 * AI 要看画布的截图（设计工具的 screenshot）：在页面外按 1:1 画出这棵树，截成 PNG 交回服务端，
 * 连同每个控件的位置（设计稿像素），AI 拿来检查重叠、跑出画面等问题。画完一次就交回，不管成败
 */
export function CanvasCapture({
  designId,
  req,
  images,
  web,
  onDone,
}: {
  designId: string
  req: CaptureRequest
  images: Map<string, RenderImage>
  web: boolean
  onDone: (id: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const run = async () => {
      const el = box.current
      if (!el) throw new Error('画布没有画出来')
      // 等字体和图片都到了再截，不然截出来是空白
      await document.fonts?.ready
      await Promise.all(
        [...el.querySelectorAll('img')].map((img) =>
          img.complete ? null : new Promise((r) => img.addEventListener('load', r, { once: true })),
        ),
      )
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const { toPng } = await import('html-to-image')
      const data = await toPng(el, { width: req.size.X, height: req.size.Y, pixelRatio: 1 })
      const byId = new Map<string, Widget>()
      walk(req.root, (w) => byId.set(w.id, w))
      const base = el.getBoundingClientRect()
      const rects = [...el.querySelectorAll<HTMLElement>('[data-wid]')].flatMap((n) => {
        const w = byId.get(n.dataset.wid ?? '')
        if (!w) return []
        const r = n.getBoundingClientRect()
        return [{ name: w.Name, type: w.Type, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }]
      })
      await api.designCapture(designId, req.id, { data, rects })
    }
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
