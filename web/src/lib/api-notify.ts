import type { NotifyChannel, NotifyDelivery } from '@shared/notify-channels'
import { json, request } from './api'

/**
 * 设置「通知渠道」的接口（server/notify-channels.ts）。单独一个文件：api.ts 到了行数上限。
 * 渠道本身存在设置里（跟着设置页自动保存），这里只有「各行最近一次投递结果」和「发一条测试」。
 * 演示版没有后端也不该往外发请求：两个接口交给 demo-notify.ts 的模拟实现。在这里分流而不是进 demo-backend.ts：
 * 那个文件到了行数上限，而且这两条不读写演示数据
 */
export type NotifyStatus = Record<string, NotifyDelivery>
export interface NotifyTestResult {
  ok: boolean
  error: string
  status: NotifyStatus
}

export const notifyApi = {
  status: async (): Promise<NotifyStatus> =>
    import.meta.env.VITE_DEMO ? (await import('./demo-notify')).demoNotifyStatus() : request('/notify-channels/status'),
  /** 用界面上正在编辑的这一行发（可能还没保存下去） */
  test: async (channel: NotifyChannel): Promise<NotifyTestResult> =>
    import.meta.env.VITE_DEMO
      ? (await import('./demo-notify')).demoNotifyTest(channel)
      : request('/notify-channels/test', json('POST', { channel })),
}
