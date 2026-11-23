import { useSyncExternalStore } from 'react'
import { local } from '@/lib/prefs'

/**
 * 图标栏展没展开成带字的（分析稿 U4）：只有图标时 8 个入口都要悬停才知道是什么，
 * 展开后每格右边写名字。记在本机，刷新、换页都保持；和会话侧栏的收起（Sidebar.tsx 的 collapsedNow）各记各的
 */
const KEY = 'activity-bar'

let wideNow = local.get(KEY) === 'wide'
const subs = new Set<() => void>()

export function toggleActivityBar() {
  wideNow = !wideNow
  // 隐私模式禁用本地存储时只是不记住，这次打开里照样生效（local 兜住）
  local.set(KEY, wideNow ? 'wide' : 'narrow')
  for (const f of subs) f()
}

export function useActivityBarWide() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    () => wideNow,
  )
}
