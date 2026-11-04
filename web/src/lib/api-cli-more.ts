import type { ConfigValue } from '@shared/cli-config-settings'
import type { GalleryPage, GallerySort } from '@shared/cli-gallery'
import { json, request } from './api'

/**
 * CLI 的项目信任、插件市场、CLI 自己的配置项（ADR 0050）。单独一个文件：api.ts 到了行数上限
 */
export const cliMoreApi = {
  /** 项目里有哪些 CLI 只在信任后才读的文件（CLI id → 找到的），见 server/cli-trust-api.ts */
  projectTrust: (projectId: string) => request<Record<string, string[]>>(`/project-trust/${projectId}`),
  /** 插件市场的一页（server/cli-gallery.ts）：没有搜索词时是热门的前 1000 个按 sort 排 */
  cliGallery: (id: string, o: { q: string; sort: GallerySort; page: number; refresh?: boolean }) =>
    request<GalleryPage>(
      `/clis/${id}/gallery?${new URLSearchParams({ q: o.q, sort: o.sort, page: String(o.page), refresh: o.refresh ? '1' : '' })}`,
    ),
  /** 已装的 npm 包在 npm 上的最新版本：包名 → 版本 */
  cliPackagesLatest: (id: string) => request<Record<string, string>>(`/clis/${id}/packages/latest`),
  /** CLI 自己配置文件里的设置项现在的值（没写过的不列）；文件读不出来时 error 写原因 */
  cliConfig: (id: string) => request<{ values: Record<string, ConfigValue>; error: string }>(`/clis/${id}/config`),
  /** 改一项；value 为 null 是恢复默认（删掉这个键） */
  saveCliConfig: (id: string, setting: string, value: ConfigValue | null) =>
    request<{ values: Record<string, ConfigValue>; error: string }>(
      `/clis/${id}/config`,
      json('PUT', { id: setting, value }),
    ),
}
