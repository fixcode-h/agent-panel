import { extOf } from '@/lib/file-ref'
import type { FileViewer, WebPlugin } from './sdk'

/** 插件登记的文件查看器，带上是哪个插件的 */
export type OwnedFileViewer = FileViewer & { plugin: string }

/**
 * 这个文件归哪个插件的查看器看：只按扩展名判断（和 clickAction 一样，点之前就知道去哪，不用先请求一次）。
 * 两个插件登记了同一个扩展名时用先登记的；目录、没有扩展名的文件没有查看器
 */
export function pickFileViewer(
  plugins: Iterable<[string, Pick<WebPlugin, 'fileViewers'>]>,
  path: string,
): OwnedFileViewer | undefined {
  const ext = extOf(path)
  if (!ext || /[\\/]$/.test(path)) return undefined
  for (const [plugin, p] of plugins)
    for (const v of p.fileViewers ?? []) if (v.exts.some((e) => e.toLowerCase() === ext)) return { ...v, plugin }
  return undefined
}
