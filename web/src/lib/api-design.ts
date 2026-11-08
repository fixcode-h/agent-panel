/** UI 设计、风格库、浏览器扩展的接口：从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入，调用方照旧用 api.xxx */
import type {
  Annotation,
  BrowserStatus,
  CaptureRequest,
  Design,
  DesignChatInput,
  DesignDoc,
  DesignJob,
  DesignMeta,
  DesignProject,
  DesignProjectInput,
  DesignVersion,
  DesignVersionMeta,
  ImageSource,
  NewDesignInput,
  ProjectComponents,
  ProjectPrompt,
  PromptAiInput,
  SavedStyle,
  SavedStyleInput,
} from '@shared/design'
import { json, request, type DesignFull } from './api'

export const designApi = {
  designs: () => request<DesignMeta[]>('/designs'),
  designProjects: () => request<DesignProject[]>('/designs/projects'),
  createDesignProject: (input: DesignProjectInput) => request<DesignProject>('/designs/projects', json('POST', input)),
  updateDesignProject: (id: string, input: Partial<DesignProjectInput>) =>
    request<DesignProject>(`/designs/projects/${id}`, json('PUT', input)),
  deleteDesignProject: (id: string) => request<void>(`/designs/projects/${id}`, { method: 'DELETE' }),
  design: (id: string) => request<DesignFull>(`/designs/${id}`),
  createDesign: (input: NewDesignInput) => request<Design>('/designs', json('POST', input)),
  /** baseRev：页面这份编辑基于服务端的哪个版本；比服务端旧时结构不收（AI 已经改过了） */
  saveDesign: (id: string, doc: DesignDoc, baseRev?: number) =>
    request<DesignFull & { rejected?: 'ai' | 'stale' }>(`/designs/${id}`, json('PUT', { ...doc, baseRev })),
  copyDesign: (id: string, projectId?: string) => request<Design>(`/designs/${id}/copy`, json('POST', { projectId })),
  moveDesign: (id: string, projectId: string) =>
    request<DesignMeta>(`/designs/${id}/move`, json('POST', { projectId })),
  deleteDesign: (id: string) => request<void>(`/designs/${id}`, { method: 'DELETE' }),
  designChat: (id: string, input: DesignChatInput) => request<DesignFull>(`/designs/${id}/chat`, json('POST', input)),
  designConcept: (id: string, action: 'select' | 'approve' | 'remove', conceptId: string) =>
    request<DesignFull>(`/designs/${id}/concept`, json('POST', { action, id: conceptId })),
  uploadConcept: (id: string, data: string) =>
    request<DesignFull>(`/designs/${id}/concept/upload`, json('POST', { data })),
  /** 只重绘原画上蒙版涂过的区域；只有本机 ComfyUI 支持，别的来源服务端会拒绝 */
  inpaintConcept: (id: string, body: { id: string; mask: Annotation; text?: string; source: ImageSource }) =>
    request<DesignFull>(`/designs/${id}/concept/inpaint`, json('POST', body)),
  designCapture: (
    id: string,
    captureId: string,
    body: {
      data?: string
      rects?: { name: string; type: string; x: number; y: number; w: number; h: number }[]
      error?: string
    },
  ) => request<{ ok: boolean }>(`/designs/${id}/capture/${captureId}`, json('POST', body)),
  /** 长轮询等 AI 要的截图请求：没有请求时服务端挂起（最长 25 秒），后台标签页也能及时收到 */
  designCaptureWait: (id: string, signal: AbortSignal) =>
    request<{ capture: CaptureRequest | null }>(`/designs/${id}/capture/wait`, { signal }),
  /** AI 正在跑时发消息：整条消息补充给这一轮，收不下就在这一轮结束后自动接着处理 */
  steerDesign: (id: string, input: DesignChatInput) =>
    request<DesignFull & { steered: boolean; queued: boolean }>(`/designs/${id}/steer`, json('POST', input)),
  stopDesign: (id: string) => request<DesignJob | null>(`/designs/${id}/stop`, json('POST', {})),
  uploadDesignImage: (id: string, body: { data: string; name?: string; imageId?: string }) =>
    request<DesignFull>(`/designs/${id}/images`, json('POST', body)),
  generateDesignImage: (
    id: string,
    imageId: string,
    body: { source: ImageSource; count: number; prompt?: string; revision?: string; refine?: boolean },
  ) => request<DesignFull>(`/designs/${id}/images/${imageId}/generate`, json('POST', body)),
  projectComponents: (projectId: string) => request<ProjectComponents[]>(`/designs/projects/${projectId}/components`),
  importComponent: (id: string, body: { from: string; name: string }) =>
    request<DesignFull>(`/designs/${id}/components/import`, json('POST', body)),
  generateDesignImages: (id: string, body: { ids: string[]; source: ImageSource; count: number }) =>
    request<DesignFull>(`/designs/${id}/images/generate`, json('POST', body)),
  designVersions: (id: string) => request<DesignVersionMeta[]>(`/designs/${id}/versions`),
  designVersion: (id: string, vid: string) => request<DesignVersion>(`/designs/${id}/versions/${vid}`),
  saveDesignVersion: (id: string, name: string) =>
    request<DesignVersionMeta>(`/designs/${id}/versions`, json('POST', { name })),
  restoreDesignVersion: (id: string, vid: string) =>
    request<DesignFull>(`/designs/${id}/versions/${vid}/restore`, json('POST', {})),
  deleteDesignVersion: (id: string, vid: string) =>
    request<void>(`/designs/${id}/versions/${vid}`, { method: 'DELETE' }),
  retryDesignImage: (id: string, imageId: string, body: { source: ImageSource; count: number }) =>
    request<DesignFull>(`/designs/${id}/images/${imageId}/retry`, json('POST', body)),
  exportDesignToProject: (id: string) => request<{ dir: string }>(`/designs/${id}/export-to-project`, json('POST', {})),
  browserStatus: () => request<BrowserStatus>('/designs/browser'),
  promptAi: (input: Partial<PromptAiInput>) =>
    request<{ prompts: Omit<ProjectPrompt, 'id' | 'enabled'>[] }>('/designs/prompts/ai', json('POST', input)),
  styles: () => request<SavedStyle[]>('/designs/styles'),
  createStyle: (input: SavedStyleInput) => request<SavedStyle>('/designs/styles', json('POST', input)),
  updateStyle: (id: string, patch: Partial<SavedStyleInput>) =>
    request<SavedStyle>(`/designs/styles/${id}`, json('PUT', patch)),
  deleteStyle: (id: string) => request<void>(`/designs/styles/${id}`, { method: 'DELETE' }),
  /** 让 CLI 总结设计的整体风格（还没存） */
  extractStyle: (designId: string, scope: string) =>
    request<Omit<SavedStyleInput, 'kind'>>(`/designs/${designId}/extract-style`, json('POST', { scope })),
  installExtension: (browser: string) =>
    request<{ dir: string }>('/designs/browser/install', json('POST', { browser })),
  reloadExtension: (browser: string) =>
    request<{ auto: boolean }>('/designs/browser/reload', json('POST', { browser })),
  revealExtension: () => request<{ ok: boolean }>('/designs/browser/reveal', json('POST', {})),
}
