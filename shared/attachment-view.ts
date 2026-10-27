/**
 * 输入框里一个附件的状态和显示。
 *
 * 附件加进来马上显示，拷贝 / 上传都在后台进行：有原路径的（浏览器选的文件按名字找回来、
 * 粘贴或拖入的本机文件）后台拷一份到数据目录，拷不了就降级成引用原路径；剪贴板截图没有路径，
 * 仍走浏览器上传。发送时按状态挑：拷贝好的用副本，拷贝中或失败的用原路径，
 * 只有还没拿到路径的（查找中、上传中）才拦一下。
 */
import { t } from './i18n.ts'
import type { Attachment } from './schema.ts'

/** locating：按名字找回原路径；copying：后台拷贝；copied：已拷到数据目录；ref：引用原路径；
 * uploading：没有路径的附件在浏览器上传；ready：已经可以发送 */
export type ItemState = 'locating' | 'copying' | 'copied' | 'ref' | 'uploading' | 'ready'

/** 附件条目的最小形状：输入框里的状态机（web）和单测共用 */
export interface ItemLike {
  name: string
  mime: string
  size: number
  quote?: string
  /** 引入时的原路径；剪贴板截图没有 */
  source?: string
  done?: Attachment
  state: ItemState
}

/** 卡片上显示的文件大小 */
export function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 小于等于设置里「大文件」阈值的走后台拷贝，更大的直接引用原路径 */
export type AttachRoute = 'copy' | 'ref'
export const routeOf = (size: number, limit: number): AttachRoute => (size > limit ? 'ref' : 'copy')

/** 状态文案：输入框卡片和发送拦截提示用的是这一套 */
export function itemStatus(state: ItemState) {
  switch (state) {
    case 'locating':
      return t('查找中')
    case 'copying':
      return t('拷贝中')
    case 'copied':
      return t('已拷贝')
    case 'ref':
      return t('引用路径')
    case 'uploading':
      return t('上传中')
    default:
      return ''
  }
}

/** 卡片上的路径：原路径优先，没有时用拷好的数据目录路径，最后退回文件名 */
export const itemPath = (x: Pick<ItemLike, 'source' | 'done' | 'name'>) => x.source ?? x.done?.path ?? x.name

/** 卡片上的文字：@路径 + 大小 + 状态；引用卡片显示原文摘要，不换 */
export function chipTextOf(x: ItemLike) {
  if (x.quote !== undefined || x.done?.quote !== undefined) return undefined
  return { label: `@${itemPath(x)} · ${formatSize(x.size)}`, status: itemStatus(x.state) }
}

/**
 * 发送时交给服务端的那份附件：已经拷好 / 传好的用它；拷贝中、拷失败的用原路径引用（ref，
 * 不再拷进对话目录）。还没有路径的（查找中、上传中）没有可发的，发送会被拦下。
 */
export function sendAttachmentOf(x: ItemLike): Attachment | undefined {
  if (x.done) return x.done
  // 引用卡片的原文还没传成文件：等它传完，服务端要按文件路径认回原文
  if (x.quote !== undefined) return undefined
  if (x.source) return { name: x.name, path: x.source, size: x.size, mime: x.mime, ref: true }
  return undefined
}

/** 这一项会不会拦住发送：只有「还没有可发的路径」的才会 */
export const blocksSend = (x: ItemLike) => !sendAttachmentOf(x)

/** 这一批附件交给服务端的样子 */
export const sendAttachments = (items: readonly ItemLike[]) =>
  items.flatMap((x) => {
    const a = sendAttachmentOf(x)
    return a ? [a] : []
  })
