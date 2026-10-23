/**
 * 附件图片的加载结果怎么落到界面上。
 * 图片地址拿到了不等于能显示：附件被清理、任务目录被删时接口返回 404，img 标签会显示成破图。
 * 这里把结果分成「能显示的地址」和「找不到的路径」，气泡按它决定显示缩略图还是图标。
 */

/** [路径, 地址, 图片能不能真的加载出来] → 能显示的地址 + 找不到的路径 */
export function shownImages(list: readonly (readonly [path: string, url: string, ok: boolean])[]) {
  const urls: Record<string, string> = {}
  const missing: Record<string, true> = {}
  for (const [path, url, ok] of list) {
    if (ok && url) urls[path] = url
    else missing[path] = true
  }
  return { urls, missing }
}
