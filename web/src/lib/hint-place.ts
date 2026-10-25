/**
 * 悬停提示浮层的位置计算。
 *
 * 为什么不交给浮层库：它会在浮层外面再包一层定位 div，那层不跟着 pointer-events-none，
 * 于是悬停提示会把鼠标下面的按钮挡住点不到（原生 title 从不挡）。
 * 这里只做提示需要的三件事：优先放上方、放不下翻到下方、左右夹在视口里。
 */

/** 浮层离触发元素的间距 */
export const OFFSET_PX = 6
/** 浮层离视口边缘至少留这么多，窄屏时也不会被切掉 */
export const VIEWPORT_PADDING = 12
/** 触发元素中心比这更靠左（侧栏那一列）时提示向右展开，免得挡住页面主要内容 */
export const SIDE_FLIP_LEFT = 320
/** 提示框最大宽度：长文字在这个宽度里换行，再宽会挡住整个页面 */
export const MAX_HINT_WIDTH_PX = 320

export type HintSide = 'top' | 'bottom' | 'right'

export type Rect = { left: number; right: number; top: number; bottom: number }
export type Size = { width: number; height: number }
export type Viewport = { width: number; height: number }
/** 浮层落在哪儿，以及贴的是触发元素的哪一边 */
export type Placement = { left: number; top: number; side: HintSide }

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

export function place(anchor: Rect, size: Size, viewport: Viewport): Placement {
  // 侧栏那一列元素往右放：往上放会盖住它右边的列表内容
  if (anchor.left + (anchor.right - anchor.left) / 2 < SIDE_FLIP_LEFT) {
    const left = anchor.right + OFFSET_PX
    // 右边放得下才往右，否则退回上下
    if (left + size.width <= viewport.width - VIEWPORT_PADDING)
      return {
        left,
        top: clamp(anchor.top, VIEWPORT_PADDING, viewport.height - size.height - VIEWPORT_PADDING),
        side: 'right',
      }
  }

  const above = anchor.top - OFFSET_PX - size.height
  const below = anchor.bottom + OFFSET_PX
  // 上方放得下就放上方；都放不下时选空间大的那边（按触发元素上下留白比较）
  const useAbove =
    above >= VIEWPORT_PADDING ||
    (below + size.height > viewport.height - VIEWPORT_PADDING && anchor.top > viewport.height - anchor.bottom)
  return {
    left: clamp(
      anchor.left,
      VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, viewport.width - size.width - VIEWPORT_PADDING),
    ),
    top: clamp(
      useAbove ? above : below,
      VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, viewport.height - size.height - VIEWPORT_PADDING),
    ),
    side: useAbove ? 'top' : 'bottom',
  }
}
