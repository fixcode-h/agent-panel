/**
 * 右栏（文件面板、功能面板）的默认宽度：对话和右栏各占一半（用户 2026-11 要求：
 * 有功能面板时默认功能面板和对话面板各占一半宽）。
 *
 * 只在没有拖动记录时用：用户拖过的宽度记在本机（见 components/ui/resize.tsx 的 usePaneWidth），
 * 有记录就按记的那个来，不回到对半。
 */

/** 左边栏展开时占的宽度，按窗口估算右栏一半时要先减掉它 */
export const RAIL_WIDTH = 224

/** 拿不到窗口宽度时（SSR、首帧）先用它，和文件面板一直用的兜底一致 */
export const PANE_DEFAULT_SSR = 340

/**
 * 右栏这一行分给右边多少：一半，但不少于 min。
 * min 是右栏自己放得下的最小宽度（文件面板 PANE_MIN、功能面板 REPORT_PANE_MIN）：
 * 窗口窄到一半比它还小（约 864 以下）时按下限，那时不再追求对半。
 */
export function paneHalfWidth(rowWidth: number, min: number) {
  return Math.max(min, Math.round(rowWidth / 2))
}

/** 容器还没挂上时按窗口估算同一行有多宽：窗口减掉左边栏 */
export function rowWidthFromWindow(winWidth: number) {
  return winWidth - RAIL_WIDTH
}
