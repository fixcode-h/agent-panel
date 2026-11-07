import type { RepeatGroup, RestoreElement, RestoreStep } from '@shared/restore/schema'
import { json, request, type DesignFull } from './api'

/** 照原画还原的接口（server/design-restore.ts；演示版在 demo-restore.ts） */
export const restoreApi = {
  source: (id: string, body: { data: string; name: string; width: number; height: number }) =>
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

/** 选的原画转成 PNG 的 data URL（服务端只解 PNG），顺便量出宽高 */
export async function artToPng(file: File) {
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
