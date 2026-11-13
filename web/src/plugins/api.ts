import type { ConfigFinding } from '@shared/config-scan'
import type { PluginManifest, PluginSource } from '@shared/plugins/types'
import type { PluginUpdate } from '@shared/plugins/version'
import { t } from '@shared/i18n'
import { request } from '@/lib/api'
import { trackedFetch } from '@/lib/connection'

/** 插件接口（server/plugins/api.ts）：装、删、开关、参数、市场 */

export interface MarketEntry {
  id: string
  name: string
  version: string
  description: string
  icon: string
  tag?: string
  asset?: string
  path?: string
  homepage?: string
}

/** 插件市场的结果（server/plugins/market-cache.ts） */
export interface MarketResult {
  repo: string
  defaultRepo: string
  /** null：这个仓库没有插件目录，整个仓库当作一个插件 */
  plugins: MarketEntry[] | null
  fetchedAt: string
  /** 这次重读失败的原因（给的是旧缓存） */
  error?: string
}

/** 安装预览：服务端下载、校验好了，等用户确认 */
export interface InstallPreview {
  token: string
  manifest: PluginManifest
  hasCode: boolean
  installed: { version: string; source: PluginSource } | null
  /** 配置安全扫描的发现（老的服务端没有）；scanScope 是点「这条没问题」时记的范围 */
  scan?: ConfigFinding[]
  scanScope?: string
}

export interface KeptItem {
  kind: 'workflow' | 'agent'
  id: string
  name: string
  why: string
}
export interface RemovalPreview {
  workflows: string[]
  agents: string[]
  kept: KeptItem[]
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export const pluginApi = {
  /** 插件市场：先给服务端的缓存，refresh 才去 GitHub 重读；不传 repo 用最后用的市场仓库 */
  market: (opts: { repo?: string; refresh?: boolean } = {}) =>
    request<MarketResult>(
      `/plugins/market?${new URLSearchParams({ ...(opts.repo && { repo: opts.repo }), ...(opts.refresh && { refresh: '1' }) })}`,
    ),
  /** 从 GitHub 装的插件和上游比版本 */
  updates: (refresh = false) =>
    request<{ updates: PluginUpdate[]; errors: { repo: string; error: string }[]; checkedAt: string }>(
      `/plugins/updates${refresh ? '?refresh=1' : ''}`,
    ),
  fromGithub: (input: { repo: string; id?: string; ref?: string; path?: string }) =>
    request<InstallPreview>('/plugins/install/github', json('POST', input)),
  fromDir: (dir: string) => request<InstallPreview>('/plugins/install/dir', json('POST', { dir })),
  /** zip 原样作为请求体上传，文件名放在地址里 */
  fromZip: async (file: File): Promise<InstallPreview> => {
    if (import.meta.env.VITE_DEMO) throw new Error(t('在线演示不能安装插件，要在本机运行面板'))
    const res = await trackedFetch(`/api/plugins/install/zip?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      // 只放行 octet-stream 的原始请求体（server/http-guards.ts）：它不是简单请求，跨站发不过来
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error ?? t('请求失败（{status}）', { status: res.status }))
    return body
  },
  confirm: (token: string) => request<{ ok: true }>('/plugins/install/confirm', json('POST', { token })),
  update: (id: string, patch: { enabled?: boolean; config?: Record<string, string | number | boolean> }) =>
    request<{ ok: true; removed: { kept: KeptItem[]; skillsKept: string[] } | null; error: string }>(
      `/plugins/${encodeURIComponent(id)}`,
      json('PUT', patch),
    ),
  remove: (id: string) =>
    request<{ ok: true; kept: KeptItem[]; skillsKept: string[] }>(`/plugins/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  rollback: (id: string) =>
    request<{ ok: true; error: string }>(`/plugins/${encodeURIComponent(id)}/rollback`, json('POST', {})),
  removal: (id: string) => request<RemovalPreview>(`/plugins/${encodeURIComponent(id)}/removal`),
  status: (id: string) => request<Record<string, unknown>>(`/plugins/${encodeURIComponent(id)}/status`),
}
