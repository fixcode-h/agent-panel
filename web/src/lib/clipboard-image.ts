// 把图片写进系统剪贴板：浏览器只认 PNG，jpeg / webp / gif 先用 canvas 转一次。
// 能不能写只在这里判断，菜单据此决定是否禁用并说明原因。
import { t } from '@shared/i18n'

/**
 * 现在这个页面为什么不能写图片进剪贴板；能写时是 null。
 * ClipboardItem 和 clipboard.write 都得有，而且得在安全上下文（HTTPS 或 localhost）里。
 */
export function imageCopyBlocked(): string | null {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return t('这个浏览器不支持把图片写进剪贴板')
  if (!window.isSecureContext) return t('剪贴板写入只在 HTTPS 或 localhost 下可用')
  return null
}

/** 不是 PNG 的图片先画到 canvas 上再导出成 PNG；<img> 能解 svg、gif，createImageBitmap 在部分浏览器里不行 */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(t('浏览器没有给出画布，没法把图片转成 PNG'))
    ctx.drawImage(img, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('图片转成 PNG 失败')))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 复制一张图片到系统剪贴板；不支持或失败时抛出带原因的错，由调用方提示用户 */
export async function copyImage(blob: Blob) {
  const blocked = imageCopyBlocked()
  if (blocked) throw new Error(blocked)
  const png = await toPng(blob)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
