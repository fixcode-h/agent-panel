import { useEffect, useState } from 'react'
import type { CaptureRequest } from '@shared/design'
import { api, designFileUrl } from '@/lib/api'
import { CanvasCapture } from './CanvasCapture'
import type { RenderImage } from './umg-render'
import type { DesignData } from '@shared/design-data'

interface Job {
  req: CaptureRequest
  images: Map<string, RenderImage>
  web: boolean
  data?: DesignData
}

/**
 * 只挂截图组件的页面（`#/capture/<设计 id>`）：设计页没人开着时，服务端用无头浏览器打开它
 * （server/headless.ts），它和设计页一样长轮询领截图请求、用同一个画布组件画出来交回。
 * 不渲染面板的其他部分，加载快、没有轮询设计和对话的开销
 */
export function CaptureHost({ id }: { id: string }) {
  const [queue, setQueue] = useState<Job[]>([])
  useEffect(() => {
    const ctrl = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      while (!ctrl.signal.aborted) {
        try {
          const r = await api.designCaptureWait(id, ctrl.signal)
          if (ctrl.signal.aborted || !r.capture) continue
          const req = r.capture
          // 每次都重新取一次设计：这一轮里新生成的图片要画进去
          const d = await api.design(id)
          const images = new Map<string, RenderImage>()
          for (const i of d.images) {
            const v = i.variants[i.selected] ?? i.variants.at(-1)
            if (v)
              images.set(i.id, {
                url: designFileUrl(id, v.file),
                width: v.width || i.width,
                height: v.height || i.height,
              })
          }
          setQueue((q) => [...q, { req, images, web: d.kind === 'web', data: req.data ?? d.data }])
        } catch {
          if (ctrl.signal.aborted) return
          // 面板重启或暂时连不上：歇一下再连
          await new Promise<void>((r) => {
            retry = setTimeout(r, 2000)
          })
        }
      }
    }
    void loop()
    return () => {
      ctrl.abort()
      clearTimeout(retry)
    }
  }, [id])
  const cur = queue[0]
  return cur ? (
    <CanvasCapture
      key={cur.req.id}
      designId={id}
      req={cur.req}
      images={cur.images}
      web={cur.web}
      data={cur.data}
      onDone={(cid) => setQueue((q) => q.filter((j) => j.req.id !== cid))}
    />
  ) : null
}
