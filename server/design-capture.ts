import type { CaptureRequest } from '../shared/design.ts'
import { t } from '../shared/i18n.ts'
import type { WidgetRect } from './design-mcp.ts'

/** 页面画好交回的截图 */
export interface CaptureShot {
  png: Buffer
  rects: WidgetRect[]
}

interface Pending {
  designId: string
  view: CaptureRequest
  resolve: (shot: CaptureShot) => void
  reject: (e: Error) => void
  /** 已经交给页面；页面可能正在截图，也可能已经切走 */
  delivered: boolean
  grace: ReturnType<typeof setTimeout>
  timeout: ReturnType<typeof setTimeout>
}

interface Page {
  designId: string
  take: (capture: CaptureRequest) => void
  close: () => void
}

export function captureNoPage() {
  return new Error(t('截图失败：设计页面没有打开。先打开这个设计页（浏览器标签页在后台也可以），再让我截图'))
}

export function captureNoShot() {
  return new Error(t('截图失败：设计页面收到了请求，但没有交出截图（页面可能已经切走，或者渲染卡住了），请重试'))
}

/**
 * AI 的 screenshot 工具等页面交回截图。
 *
 * 页面靠 `wait` 长轮询拿请求：后台标签页里 setInterval 会被浏览器节流到一分钟一次，
 * 20 秒的截图超时必然先到；已经挂着的 fetch 一有响应就会继续执行，不受节流影响。
 * 还没有页面接手时快速失败，能说清楚是「页面没打开」而不是一律报渲染失败。
 */
export class DesignCaptures {
  private pending = new Map<string, Pending>()
  private pages = new Map<string, Set<Page>>()
  /** 页面刚打开、长轮询还在路上时给一点宽限，避免误报没打开 */
  private graceMs: number
  /** 页面收到请求后最多等这么久 */
  private timeoutMs: number
  /** 一次长轮询最长挂多久，到期由页面立刻重连 */
  private askMs: number

  constructor(opts: { graceMs?: number; timeoutMs?: number; askMs?: number } = {}) {
    this.graceMs = opts.graceMs ?? 2_000
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.askMs = opts.askMs ?? 25_000
  }

  /** AI 要一张截图：交给正在盯着这个设计的页面；没有页面时宽限结束就报「页面没打开」 */
  request(designId: string, view: CaptureRequest): Promise<CaptureShot> {
    return new Promise<CaptureShot>((resolve, reject) => {
      const p = {
        designId,
        view,
        resolve,
        reject,
        delivered: false,
        grace: setTimeout(() => {
          if (!this.isCurrent(designId, view.id) || p.delivered) return
          this.settle(p, captureNoPage())
        }, this.graceMs),
        timeout: setTimeout(() => {
          this.settle(p, p.delivered ? captureNoShot() : captureNoPage())
        }, this.timeoutMs),
      }
      this.pending.set(view.id, p)
      this.flush(designId)
    })
  }

  /** 页面长轮询：有请求立刻给，没有就挂到 askMs 或页面离开 */
  wait(designId: string, signal?: AbortSignal): Promise<CaptureRequest | null> {
    const ready = this.take(designId)
    if (ready) return Promise.resolve(ready)
    if (signal?.aborted) return Promise.resolve(null)
    return new Promise<CaptureRequest | null>((resolve) => {
      const page: Page = {
        designId,
        take: (view) => {
          cleanup()
          resolve(view)
        },
        close: () => {
          cleanup()
          resolve(null)
        },
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        const set = this.pages.get(designId)
        set?.delete(page)
        if (set && !set.size) this.pages.delete(designId)
        signal?.removeEventListener('abort', close)
      }
      const close = () => page.close()
      timer = setTimeout(close, this.askMs)
      const set = this.pages.get(designId) ?? new Set<Page>()
      set.add(page)
      this.pages.set(designId, set)
      signal?.addEventListener('abort', close, { once: true })
    })
  }

  /** 页面交回截图 */
  deliver(designId: string, cid: string, shot: CaptureShot) {
    const p = this.pending.get(cid)
    if (!p || p.designId !== designId) return false
    this.settle(p, undefined, shot)
    return true
  }

  /** 页面画不出来，交回原因 */
  fail(designId: string, cid: string, message: string) {
    const p = this.pending.get(cid)
    if (!p || p.designId !== designId) return false
    this.settle(p, new Error(message))
    return true
  }

  /** 这一轮结束了：还在等的截图不用等；页面连接也一起关掉 */
  stop(designId: string, error: Error) {
    for (const p of [...this.pending.values()]) if (p.designId === designId) this.settle(p, error)
    for (const page of [...(this.pages.get(designId) ?? [])]) page.close()
  }

  /** 只删自己这一条：请求超时后页面迟到的回传不要影响下一次 */
  private isCurrent(designId: string, cid: string) {
    const p = this.pending.get(cid)
    return !!p && p.designId === designId
  }

  private take(designId: string): CaptureRequest | null {
    for (const p of this.pending.values()) {
      if (p.designId !== designId || p.delivered) continue
      p.delivered = true
      clearTimeout(p.grace)
      return p.view
    }
    return null
  }

  /** 把还没下发的请求配给在等的页面 */
  private flush(designId: string) {
    for (const page of [...(this.pages.get(designId) ?? [])]) {
      const view = this.take(designId)
      if (!view) return
      page.take(view)
    }
  }

  private settle(p: Pending, error?: Error, shot?: CaptureShot) {
    clearTimeout(p.grace)
    clearTimeout(p.timeout)
    if (this.pending.get(p.view.id) === p) this.pending.delete(p.view.id)
    if (error) p.reject(error)
    else p.resolve(shot!)
  }
}
