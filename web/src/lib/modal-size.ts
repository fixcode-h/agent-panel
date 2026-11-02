/**
 * 弹窗拖拽调整大小的纯逻辑：尺寸约束、按弹窗记忆、四边/四角拖拽的计算都在这里。
 * 组件层（components/ui/modal-resize.tsx）只负责量真实尺寸、挂手柄和写样式；
 * 放在 lib 里是为了能在 node:test 里直接测，不用起浏览器。
 *
 * 弹窗仍然居中（Radix 的 top-1/2 left-1/2 translate），所以拖边时按居中对称伸缩：
 * 拖右边缘 dx 像素，宽度变化 2*dx，被拖的那条边跟手，左边同时反向让开。
 */

/** 弹窗能缩到的最小尺寸：再小标题栏、底部按钮就会被挤坏 */
export const MODAL_MIN_SIZE = { w: 320, h: 200 } as const

/** 弹窗和视口边缘至少留出的距离：和现有尺寸档的 3.75rem 居中留白一致（两侧各 30px） */
export const MODAL_VIEWPORT_GAP = 30

/** 本机记住的弹窗尺寸键前缀 */
export const MODAL_SIZE_STORAGE_PREFIX = 'modal-size:'

export interface DialogSize {
  w: number
  h: number
}

export interface DialogSizeBounds {
  minW: number
  minH: number
  maxW: number
  maxH: number
}

/** 某条边/某个角往哪个方向拖：-1 左/上，1 右/下，0 不动 */
export type ResizeDirection = -1 | 0 | 1

/** 视口能放下的弹窗尺寸：四周各留 MODAL_VIEWPORT_GAP，视口比最小尺寸还小时以视口为准 */
export function modalSizeBounds(viewportW: number, viewportH: number): DialogSizeBounds {
  const maxW = Math.max(1, viewportW - MODAL_VIEWPORT_GAP * 2)
  const maxH = Math.max(1, viewportH - MODAL_VIEWPORT_GAP * 2)
  return {
    minW: Math.min(MODAL_MIN_SIZE.w, maxW),
    minH: Math.min(MODAL_MIN_SIZE.h, maxH),
    maxW,
    maxH,
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** 把尺寸收进当前约束：低于最小值抬起来、超过视口压回去，最后取整 */
export function clampDialogSize(size: DialogSize, bounds: DialogSizeBounds): DialogSize {
  return {
    w: Math.round(clamp(size.w, bounds.minW, bounds.maxW)),
    h: Math.round(clamp(size.h, bounds.minH, bounds.maxH)),
  }
}

/**
 * 按拖拽位移算新尺寸。
 * - 边：只改一个方向，被拖的那条边跟手（居中对称，所以宽度变化是位移的 2 倍）
 * - 角：按拖拽开始时的宽高比等比缩放，取两轴里相对变化更大的那个决定缩放系数
 */
export function resizeDialogSize(
  start: DialogSize,
  dirX: ResizeDirection,
  dirY: ResizeDirection,
  dx: number,
  dy: number,
  bounds: DialogSizeBounds,
): DialogSize {
  if (start.w <= 0 || start.h <= 0) return clampDialogSize(start, bounds)
  if (dirX !== 0 && dirY !== 0) {
    const scaleW = 1 + (2 * dirX * dx) / start.w
    const scaleH = 1 + (2 * dirY * dy) / start.h
    const scale = Math.abs(scaleW - 1) >= Math.abs(scaleH - 1) ? scaleW : scaleH
    const minScale = Math.max(bounds.minW / start.w, bounds.minH / start.h)
    const maxScale = Math.min(bounds.maxW / start.w, bounds.maxH / start.h)
    const kept = clamp(scale, minScale, maxScale)
    return { w: Math.round(start.w * kept), h: Math.round(start.h * kept) }
  }
  return clampDialogSize({ w: start.w + 2 * dirX * dx, h: start.h + 2 * dirY * dy }, bounds)
}

/**
 * 一份尺寸记忆存在哪：显式 resizeKey 优先；否则用尺寸档 + 标题文字。
 * 标题不是字符串（富标题、null）时退回档位——至少同档弹窗能用一份记忆，不会读到别的档。
 */
export function modalSizeKey(explicit: string | undefined, title: unknown, tier: string): string {
  const fixed = explicit?.trim()
  if (fixed) return fixed
  const text = typeof title === 'string' ? title.trim() : ''
  return text ? `${tier}:${text}` : tier
}

/** 只取读写这两个方法，测试里可以传内存实现 */
export interface ModalSizeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 读本机记着的尺寸；没有、坏数据、非正数都当作没记过 */
export function readModalSize(storage: ModalSizeStorage, key: string): DialogSize | null {
  try {
    const raw = storage.getItem(MODAL_SIZE_STORAGE_PREFIX + key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { w, h } = parsed as Record<string, unknown>
    if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return null
    if (w <= 0 || h <= 0) return null
    return { w, h }
  } catch {
    return null
  }
}

/** 写本机记忆；隐私模式等写不进去时静默跳过（尺寸照样能拖，只是下次不恢复） */
export function writeModalSize(storage: ModalSizeStorage, key: string, size: DialogSize): void {
  try {
    storage.setItem(MODAL_SIZE_STORAGE_PREFIX + key, JSON.stringify({ w: Math.round(size.w), h: Math.round(size.h) }))
  } catch {}
}
