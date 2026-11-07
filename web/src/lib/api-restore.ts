import type { RepeatGroup, RestoreElement, RestoreStep } from '@shared/restore/schema'
import { json, request, type DesignFull } from './api'

/** 照原画还原的接口（server/design-restore.ts；演示版在 demo-restore.ts） */
export const restoreApi = {
  source: (id: string, body: { data: string; name: string; width: number; height: number; psd?: boolean }) =>
    request<DesignFull>(`/designs/${id}/restore/source`, json('POST', body)),
  run: (id: string, step: RestoreStep, feedback = '') =>
    request<DesignFull>(`/designs/${id}/restore/run`, json('POST', { step, feedback })),
  confirm: (id: string, step: RestoreStep) =>
    request<DesignFull>(`/designs/${id}/restore/confirm`, json('POST', { step })),
  elements: (id: string, elements: RestoreElement[], groups?: RepeatGroup[]) =>
    request<DesignFull>(`/designs/${id}/restore/elements`, json('PUT', { elements, groups })),
  accept: (id: string, element: string, on: boolean) =>
    request<DesignFull>(`/designs/${id}/restore/accept`, json('POST', { element, on })),
}

export const isPsdFile = (file: File) => /\.psd$/i.test(file.name) || file.type === 'image/vnd.adobe.photoshop'

/**
 * 选的原画：图片转成 PNG 的 data URL（服务端只解 PNG），顺便量出宽高；
 * PSD 原样发过去（服务端读图层），宽高等服务端读出来，页面上只显示文件名
 */
export async function artToPng(file: File): Promise<{
  data: string
  width: number
  height: number
  name: string
  psd?: boolean
}> {
  if (isPsdFile(file)) {
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(r.error ?? new Error('read failed'))
      r.readAsDataURL(file)
    })
    return { data, width: 0, height: 0, name: file.name, psd: true }
  }
  const url = URL.createObjectURL(file)
  try {
    const im = new Image()
    im.src = url
    await im.decode()
    const c = document.createElement('canvas')
    c.width = im.naturalWidth
    c.height = im.naturalHeight
    c.getContext('2d')!.drawImage(im, 0, 0)
    return { data: c.toDataURL('image/png'), width: c.width, height: c.height, name: file.name }
  } finally {
    URL.revokeObjectURL(url)
  }
}
