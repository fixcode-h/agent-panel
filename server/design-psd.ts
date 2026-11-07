import { initializeCanvas, readPsd } from 'ag-psd'
import { importPsd, type PsdImport } from '../shared/restore/psd.ts'

/**
 * 服务端读 PSD：ag-psd 默认要用 canvas 建像素缓冲，Node 里没有 canvas，
 * 换成直接给一块字节数组（useImageData 下它只用到 createImageData）
 */
let ready = false
function init() {
  if (ready) return
  initializeCanvas(
    () => {
      throw new Error('PSD 解析不需要 canvas')
    },
    // Node 的类型里没有 ImageData：形状一样，按它要的类型交回去
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as never,
  )
  ready = true
}

/** PSD 文件头是「8BPS」 */
export const isPsd = (buf: Buffer) => buf.length > 26 && buf.toString('latin1', 0, 4) === '8BPS'

export function readPsdLayers(buf: Buffer): PsdImport {
  init()
  const psd = readPsd(buf, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true })
  return importPsd(psd)
}
