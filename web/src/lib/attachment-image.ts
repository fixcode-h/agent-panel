/**
 * 附件图片的加载结果怎么落到界面上。
 * 图片地址拿到了不等于能显示：附件被清理、任务目录被删时接口返回 404，img 标签会显示成破图。
 * 这里把结果分成「能显示的缩略图地址」「原图地址」和「找不到的路径」：
 * 气泡里 1.25em 高的卡片用缩略图，点开看大图用原图，按它决定显示缩略图还是图标。
 */

/** [路径, 缩略图地址, 原图地址, 图片能不能真的加载出来] → 缩略图 + 原图地址 + 找不到的路径 */
export function shownImages(list: readonly (readonly [path: string, thumb: string, full: string, ok: boolean])[]) {
  const urls: Record<string, string> = {}
  const fulls: Record<string, string> = {}
  const missing: Record<string, true> = {}
  for (const [path, thumb, full, ok] of list) {
    if (!ok || !thumb) {
      missing[path] = true
      continue
    }
    urls[path] = thumb
    fulls[path] = full || thumb
  }
  return { urls, fulls, missing }
}
