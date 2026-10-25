/**
 * 最小化后的浮条的位置与拖动判定。
 *
 * 抽成纯函数单独测：夹回视口、拖动阈值、位置记忆都只有这一份，三个占位不再各写一套。
 * 浏览器里没有 localStorage 时（部分环境、隐私模式）退回内存，所以这些函数在 node 里也能直接测。
 *
 * 没拖过时一律贴在右下角：屏幕任意时刻只有一个浮条（见 chat-dock.ts），不存在叠在一起的问题。
 */

/** 拖动时贴边留的空隙：拖到角上也不会只剩一条边露在外面 */
export const EDGE = 8
/** 没拖过时的默认位置：离右下角这么远，和 tailwind 的 right-5 / bottom-5 对上 */
export const DEFAULT_INSET = 20
/** 按下后移动超过这个距离才算拖动，手抖不会把这次点击吃掉 */
export const SLOP = 4

const STORE = 'minimized-chat-pos'

export interface Pos {
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

export interface View {
  w: number
  h: number
}

/** 把位置夹回视口里：窗口比浮条还窄时上限会小于下限，取下限保证位置合法 */
export const clampPos = (p: Pos, size: Size, view: View): Pos => ({
  x: Math.min(Math.max(EDGE, p.x), Math.max(EDGE, view.w - size.w - EDGE)),
  y: Math.min(Math.max(EDGE, p.y), Math.max(EDGE, view.h - size.h - EDGE)),
})

/** 按下后是否已经移动够远：够远就算拖动，不再当点击 */
export const movedEnough = (dx: number, dy: number) => Math.abs(dx) >= SLOP || Math.abs(dy) >= SLOP

type Stored = Record<string, Pos>

const memory: Stored = {}

/** 每条浮条按自己的 id 记位置：两个窗口最小化后各在各的坐标上，不会叠到一起 */
function readStore(): Stored {
  try {
    const raw = localStorage.getItem(STORE)
    const v = raw ? (JSON.parse(raw) as Stored) : {}
    return v && typeof v === 'object' ? { ...v, ...memory } : { ...memory }
  } catch {
    return { ...memory }
  }
}

/** 上次拖到的位置；没拖过（或存的值坏了）返回 null，由组件用默认槽位 */
export function loadPos(id: string): Pos | null {
  const p = readStore()[id]
  return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null
}

/** 松手后记一下：下次打开（包括刷新页面）还在原处 */
export function savePos(id: string, p: Pos) {
  memory[id] = { x: Math.round(p.x), y: Math.round(p.y) }
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...readStore(), [id]: memory[id] }))
  } catch {}
}
