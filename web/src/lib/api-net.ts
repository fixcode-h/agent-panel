import type { DetectedProxy } from '@shared/proxy'
import { request } from './api'

/**
 * 设置「网络与代理」的接口（server/env-api.ts）。单独一个文件：api.ts 到了行数上限。
 * 演示版不显示「网络与代理」这一页（SettingsPage 里按 demo 过滤），所以没有模拟实现
 */
export const netApi = {
  /** 重新探测本机正在运行的 http 代理：系统代理在前，其次常见端口 */
  detectProxies: () => request<{ proxies: DetectedProxy[] }>('/net/proxy/detect'),
}
