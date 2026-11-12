import type { ConfigValue } from '@shared/cli-config-settings'
import type { GalleryPage, GallerySort } from '@shared/cli-gallery'
import type { ChangelogEntry } from '@shared/package-changelog'
import type { InstalledPackage } from '@shared/cli-spec'
import { json, request } from './api'

/**
 * CLI 的项目信任、插件市场、CLI 自己的配置项（ADR 0050）。单独一个文件：api.ts 到了行数上限
 */
export const cliMoreApi = {
  /** 项目里有哪些 CLI 只在信任后才读的文件（CLI id → 找到的），见 server/cli/trust-api.ts */
  projectTrust: (projectId: string) => request<Record<string, string[]>>(`/project-trust/${projectId}`),
  /** 插件市场的一页（server/cli/gallery.ts）：没有搜索词时是热门的前 1000 个按 sort 排 */
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
  /** 已装插件的更新说明；包没有提供时是 null */
  packageChangelog: (id: string, source: string) =>
    request<ChangelogEntry[] | null>(`/clis/${id}/packages/changelog?${new URLSearchParams({ source })}`),
  /** 一个已装插件里各类资源（扩展、Skill……）和开关 */
  packageResources: (id: string, source: string) =>
    request<{ type: string; label: string; on: boolean }[]>(
      `/clis/${id}/packages/resources?${new URLSearchParams({ source })}`,
    ),
  setPackageResource: (id: string, source: string, type: string, on: boolean) =>
    request<{ ok: boolean }>(`/clis/${id}/packages/resources`, json('PUT', { source, type, on })),
  /** CLI 自带扩展的开关：名字 → 开着没 */
  builtins: (id: string) => request<Record<string, boolean>>(`/clis/${id}/builtins`),
  setBuiltin: (id: string, builtin: string, on: boolean) =>
    request<Record<string, boolean>>(`/clis/${id}/builtins`, json('PUT', { id: builtin, on })),
  /** 项目里的插件（装在项目的配置里，只有这个项目的对话加载） */
  projectPackages: (id: string, projectId: string) =>
    request<InstalledPackage[]>(`/clis/${id}/packages?${new URLSearchParams({ projectId })}`),
  projectPackageAction: (id: string, projectId: string, action: 'install' | 'remove', source: string) =>
    request<{ ok: boolean; output: string; packages: InstalledPackage[] }>(
      `/clis/${id}/packages?${new URLSearchParams({ projectId })}`,
      json('POST', { action, source }),
    ),
}
