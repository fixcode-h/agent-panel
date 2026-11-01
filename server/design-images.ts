import type { DesignImage } from '../shared/design.ts'
import { t } from '../shared/i18n.ts'

/**
 * 启动时读设计：上次面板退出时还在出图的图（generating / pending）出图任务已经没了，
 * 留着页面会一直轮询、批量重新生成也选不上它们。改成失败并写明原因，用户可以重新生成
 */
export function resetStuckImages(images: DesignImage[]): DesignImage[] {
  if (!images.some((i) => i.status === 'generating' || i.status === 'pending')) return images
  return images.map((i) =>
    i.status === 'generating' || i.status === 'pending'
      ? { ...i, status: 'failed' as const, error: t('面板重启，出图中断了，可以重新生成') }
      : i,
  )
}
