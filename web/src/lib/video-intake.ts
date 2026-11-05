/**
 * 拖进、粘贴进输入框的视频：不当附件发，交给截帧弹窗（见 components/video/VideoFramesDialog.tsx）。
 * 浏览器给不出文件的路径，先在本机按名字、大小、修改时间找回原路径；视频只读，不上传、不拷贝。
 */
import { t } from '@shared/i18n'
import { isVideoFile } from '@shared/video'
import type { VideoTarget } from '@/components/video/VideoFramesDialog'
import { api } from './api'
import { toast } from './toast'

export type VideoTaker = (v: VideoTarget) => void

/** 本机选文件：只交回选中的视频 */
async function pickVideo(take: VideoTaker) {
  try {
    const { files } = await api.pickFiles()
    const hit = files.find((a) => isVideoFile(a.name, a.mime))
    if (hit) take({ path: hit.path, name: hit.name })
    else if (files.length) toast.error(t('选的不是视频文件'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** 找回这些视频在本机的位置，找到的交给截帧弹窗；找不到的提示用户自己选 */
export async function takeVideos(files: File[], take: VideoTaker) {
  const found = await api
    .locateFiles(files.map((f) => ({ name: f.name, size: f.size, mtime: f.lastModified || undefined })))
    .then((r) => new Map(r.files.map((f) => [f.index, f])))
    .catch(() => new Map<number, { path: string; name: string }>())
  files.forEach((f, i) => {
    const hit = found.get(i)
    if (hit) return take({ path: hit.path, name: f.name })
    toast.error(t('没找到视频「{name}」在本机的位置，可以手动选择这个视频', { name: f.name }), {
      action: { label: t('选择视频'), onClick: () => void pickVideo(take) },
    })
  })
}
