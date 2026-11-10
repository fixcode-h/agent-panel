/** 视频截帧的接口（server/video/routes.ts）；单独一个文件，api.ts 已经很长 */
import type { AutoMode, AutoProgress, EnhanceMethod, FfmpegStatus, VideoRange, VideoSession } from '@shared/video'
import type { DiffBox, FrameShape, NamedRange, VideoPrefs } from '@shared/video-tools'
import { json, request } from './api'

type Ref = { key: string; path: string }

export const videoApi = {
  status: () => request<FfmpegStatus>('/video/status'),
  download: (mirror: boolean) => request<FfmpegStatus>('/video/ffmpeg/download', json('POST', { mirror })),
  cancelDownload: () => request<FfmpegStatus>('/video/ffmpeg/cancel', json('POST', {})),
  setPath: (path: string) => request<FfmpegStatus>('/video/ffmpeg/path', json('PUT', { path })),
  open: (path: string) => request<VideoSession>('/video/open', json('POST', { path })),
  manual: (v: Ref, time: number) => request<VideoSession>('/video/frames/manual', json('POST', { ...v, time })),
  /** signal：用户点「停止」时断开请求，服务端跟着停掉 FFmpeg；range 为空时整段截 */
  auto: (v: Ref, mode: AutoMode, count: number, range: VideoRange | null, signal?: AbortSignal) =>
    request<VideoSession>('/video/frames/auto', { ...json('POST', { ...v, mode, count, range }), signal }),
  /** 自动截帧进行到哪了（没在截时 progress 为 null） */
  progress: (key: string) =>
    request<{ progress: AutoProgress | null }>(`/video/frames/progress?key=${encodeURIComponent(key)}`),
  remove: (v: Ref, o: { which?: 'manual' | 'auto'; ids?: string[] }) =>
    request<VideoSession>('/video/frames/remove', json('POST', { ...v, ...o })),
  methods: () => request<{ methods: EnhanceMethod[] }>('/video/enhance/methods'),
  enhance: (v: Ref, ids: string[], method: string, signal?: AbortSignal) =>
    request<VideoSession>('/video/frames/enhance', { ...json('POST', { ...v, ids, method }), signal }),
  unenhance: (v: Ref, ids?: string[]) => request<VideoSession>('/video/frames/unenhance', json('POST', { ...v, ids })),
  /** 记下命名范围和弹窗设置 */
  meta: (v: Ref, o: { ranges?: NamedRange[]; prefs?: Partial<VideoPrefs> }) =>
    request<VideoSession>('/video/meta', json('POST', { ...v, ...o })),
  shapes: (v: Ref, id: string, shapes: FrameShape[]) =>
    request<VideoSession>('/video/frames/shapes', json('POST', { ...v, id, shapes })),
  /** 浏览器画好的标注图（PNG 的 data URL）；from 是底图路径 */
  annotated: (v: Ref, id: string, from: string, png: string) =>
    request<VideoSession>('/video/frames/annotated', json('POST', { ...v, id, from, png })),
  dedupe: (v: Ref) => request<{ session: VideoSession; removed: number }>('/video/frames/dedupe', json('POST', v)),
  diff: (v: Ref, id: string) =>
    request<{ prev: { id: string; time: number } | null; boxes: DiffBox[] }>(
      '/video/frames/diff',
      json('POST', { ...v, id }),
    ),
}

/** 浏览器播放用的地址（支持拖进度条） */
export const videoStreamUrl = (path: string) => `/api/video/stream?path=${encodeURIComponent(path)}`
/** 播放器放不出来的格式：这一刻的画面 */
export const videoPreviewUrl = (path: string, t: number) =>
  `/api/video/preview?path=${encodeURIComponent(path)}&t=${t.toFixed(2)}`
/** 帧图片：和附件图片同一个接口读（绝对路径的图片） */
export const frameUrl = (file: string, thumb = false) =>
  `/api/uploads/raw?path=${encodeURIComponent(file)}${thumb ? '&w=240' : ''}`
