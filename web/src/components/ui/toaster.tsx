import { useSyncExternalStore } from 'react'
import { Toaster, type ToasterProps } from 'sonner'
import { t } from '@shared/i18n'
import { COMP_SPEC, compValue } from '@shared/component-style'
import { componentsSnapshot, subscribeComponents } from '@/lib/appearance'
import { dockSnapshot, subscribeDock } from '@/lib/chat-dock'
import { DEFAULT_INSET } from '@/lib/minimized-chat'
import { TOAST_VISIBLE_LIMIT } from '@/lib/toast-queue'

/** 离窗口边缘多远：和最小化浮条默认的内缩一样，右下角两样东西对齐成一条竖线 */
const EDGE = DEFAULT_INSET
/** 最小化浮条（h-11）的高度加上和提示之间的空隙：浮条在时提示整体往上让这么多 */
const DOCK_CLEARANCE = 44 + 12

type Position = NonNullable<ToasterProps['position']>

/**
 * 全站唯一的提示容器，在 App 根部挂一次；弹提示统一走 web/src/lib/toast.ts（自己排队，同屏上限见
 * lib/toast-queue.ts 的 TOAST_VISIBLE_LIMIT）。外观在 index.css 的 [data-sonner-toast] 里。
 *
 * 位置和停留时长读设置 → 组件 →「提示」（默认右下角、4 秒），改了立刻生效：
 * - `visibleToasts` 必须和队列上限是同一个数：sonner 自己还会按 `index + 1 <= visibleToasts`
 *   把超出的那条设成 `data-visible="false"`（opacity 0、不吃指针），默认值是 3，
 *   队列放进来的第 4 条就会被它默默藏掉；设成同一个数后两者不打架。
 * - `expand` 必须有：不展开时 sonner 把非最上面那条压成一条边（内容透明），
 *   和「依次展示下来」相反；展开后鼠标悬上去也不会再整体跳一下。
 * - 放在底部时要让开最小化浮条（默认也在右下角）：以前提示就在右下角，压住浮条才挪去右上角，
 *   这次挪回来，浮条在的时候整体抬高一截。
 */
export function AppToaster({ dark }: { dark: boolean }) {
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  const docks = useSyncExternalStore(subscribeDock, dockSnapshot)
  const posKey = compValue(style, 'toast', 'position') as keyof typeof COMP_SPEC.toast.position.options
  const position = (COMP_SPEC.toast.position.options[posKey] ?? 'bottom-right') as Position
  const durKey = compValue(style, 'toast', 'duration') as keyof typeof COMP_SPEC.toast.duration.options
  const duration = Number(COMP_SPEC.toast.duration.options[durKey] ?? 4000)
  const bottom = position.startsWith('bottom') && docks.length ? EDGE + DOCK_CLEARANCE : EDGE
  return (
    <Toaster
      theme={dark ? 'dark' : 'light'}
      position={position}
      offset={{ top: EDGE, right: EDGE, bottom, left: EDGE }}
      duration={duration}
      expand
      visibleToasts={TOAST_VISIBLE_LIMIT}
      closeButton
      toastOptions={{ closeButtonAriaLabel: t('关闭') }}
    />
  )
}
