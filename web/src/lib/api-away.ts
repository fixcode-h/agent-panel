import type { AwayState } from '@shared/away'
import { json, request } from './api'

/**
 * 「我不在」的接口（server/away.ts）：开关和自动选过的记录。单独一个文件：api.ts 到了行数上限。
 * 演示版交给 demo-away.ts 的模拟实现，在这里分流而不是进 demo-backend.ts（那个文件也到了行数上限）
 */
export const awayApi = {
  get: async (): Promise<AwayState> =>
    import.meta.env.VITE_DEMO ? (await import('./demo-away')).demoAwayGet() : request('/away'),
  set: async (on: boolean): Promise<AwayState> =>
    import.meta.env.VITE_DEMO ? (await import('./demo-away')).demoAwaySet(on) : request('/away', json('PUT', { on })),
  /** 不给 id 时全部清掉 */
  drop: async (id?: string): Promise<AwayState> =>
    import.meta.env.VITE_DEMO
      ? (await import('./demo-away')).demoAwayDrop(id)
      : request(id ? `/away/picks/${encodeURIComponent(id)}` : '/away/picks', { method: 'DELETE' }),
}
