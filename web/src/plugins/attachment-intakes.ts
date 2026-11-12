import { extOf } from '@/lib/file-ref'
import type { AttachmentIntake, WebPlugin } from './sdk'

/** 插件登记的附件认领，带上是哪个插件的；key 是「插件:id」，记在输入框的附件条目上（ItemLike.intake） */
export type OwnedIntake = AttachmentIntake & { plugin: string; key: string }

type Plugins = Iterable<[string, Pick<WebPlugin, 'attachmentIntakes'>]>

/**
 * 放进输入框的这个文件归哪个插件处理（插件接口 6）：先按扩展名，再按浏览器给的 MIME 前缀。
 * 两个插件认领了同一类文件时用先登记的；没人认领就照旧当普通文件
 */
export function pickIntake(plugins: Plugins, name: string, mime = ''): OwnedIntake | undefined {
  const ext = extOf(name)
  const type = mime.toLowerCase()
  for (const [plugin, p] of plugins)
    for (const x of p.attachmentIntakes ?? [])
      if (
        (ext && x.exts.some((e) => e.toLowerCase() === ext)) ||
        (type && x.mimes?.some((m) => type.startsWith(m.toLowerCase())))
      )
        return { ...x, plugin, key: `${plugin}:${x.id}` }
  return undefined
}

/** 按条目上记的 key 找回认领它的插件；插件关掉、删除后找不到 */
export function intakeByKey(plugins: Plugins, key: string): OwnedIntake | undefined {
  for (const [plugin, p] of plugins)
    for (const x of p.attachmentIntakes ?? []) if (`${plugin}:${x.id}` === key) return { ...x, plugin, key }
  return undefined
}
