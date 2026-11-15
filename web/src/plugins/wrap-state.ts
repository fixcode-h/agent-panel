import { useSyncExternalStore } from 'react'
import type { WrapRecipe } from '@shared/plugins/wrap/recipe'

/**
 * 「从 GitHub 链接包装」弹窗开没开、开给哪个仓库（ADR 0068）。插件页顶上的菜单、包装插件卡片上的「升级」「重新安装」、
 * 「AI 帮我包装」的分析对话做完后都从这里打开同一个弹窗（WrapDialog），所以放在组件外面
 */
export interface WrapRequest {
  /** 打开时预填的链接；空表示让用户贴 */
  url: string
  /** 更新已装的包装插件 */
  update?: boolean
  /** 「AI 帮我包装」写出的配方 */
  recipe?: WrapRecipe
  /** 每次打开换一个，弹窗按它重新读预览 */
  seq: number
}

let state: WrapRequest | null = null
let seq = 0
const subs = new Set<() => void>()
const emit = (next: WrapRequest | null) => {
  state = next
  subs.forEach((f) => f())
}

export const openWrap = (req: Omit<WrapRequest, 'seq'> = { url: '' }) => emit({ ...req, seq: ++seq })
export const closeWrap = () => emit(null)
export const useWrapRequest = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
  )
