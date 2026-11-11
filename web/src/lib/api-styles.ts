/** 风格库和浏览器扩展的接口：从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入，调用方照旧用 api.xxx。
 *  UI 设计本身的接口在 UI 设计插件里；浏览器扩展的地址还是以前挂在设计接口下的 /designs/browser，扩展和旧版本认这个地址 */
import type { BrowserStatus } from '@shared/browser-ext'
import type { SavedStyle, SavedStyleInput } from '@shared/style-types'
import { json, request } from './api'

export const stylesApi = {
  browserStatus: () => request<BrowserStatus>('/designs/browser'),
  styles: () => request<SavedStyle[]>('/styles'),
  createStyle: (input: SavedStyleInput) => request<SavedStyle>('/styles', json('POST', input)),
  updateStyle: (id: string, patch: Partial<SavedStyleInput>) =>
    request<SavedStyle>(`/styles/${id}`, json('PUT', patch)),
  deleteStyle: (id: string) => request<void>(`/styles/${id}`, { method: 'DELETE' }),
  installExtension: (browser: string) =>
    request<{ dir: string }>('/designs/browser/install', json('POST', { browser })),
  reloadExtension: (browser: string) =>
    request<{ auto: boolean }>('/designs/browser/reload', json('POST', { browser })),
  revealExtension: () => request<{ ok: boolean }>('/designs/browser/reveal', json('POST', {})),
}
