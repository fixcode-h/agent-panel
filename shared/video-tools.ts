/**
 * 视频截帧的进阶工具（用户 2026-11-07 要的）：帧上标注、相似帧去重、帧差高亮、命名的截帧范围和记住的设置。
 * 这里是前后端共用的纯逻辑和数据结构；读图、写盘在 server/video/，画标注在浏览器里（web/src/components/video/）。
 */
import { z } from 'zod'

/** 标注颜色：红（默认，指问题）、黄、绿、蓝；画在任何画面上都看得清 */
export const SHAPE_COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6'] as const

/**
 * 帧上的一个标注。坐标都是相对图片宽高的比例（0~1）：缩略图、放大、增强后尺寸变了都画在同一个位置。
 * rect 框住一块；arrow 从 (x1,y1) 指向 (x2,y2)；text 是一句备注，左上角在 (x,y)
 */
const n01 = z.number().min(0).max(1)
export const FrameShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rect'), x: n01, y: n01, w: n01, h: n01, color: z.string().max(20) }),
  z.object({ kind: z.literal('arrow'), x1: n01, y1: n01, x2: n01, y2: n01, color: z.string().max(20) }),
  z.object({
    kind: z.literal('text'),
    x: n01,
    y: n01,
    text: z.string().trim().min(1).max(200),
    color: z.string().max(20),
  }),
])
export type FrameShape = z.infer<typeof FrameShape>

/** 一张帧最多多少个标注：再多画面就乱了，AI 也看不出重点 */
export const SHAPES_MAX = 30

/** 命名的截帧范围（秒）：一个视频可以记几段（比如「第一次复现」「第二次复现」），重新打开弹窗还在 */
export const NamedRange = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().max(40).default(''),
  start: z.number().min(0),
  end: z.number().min(0),
})
export type NamedRange = z.infer<typeof NamedRange>

/** 一个视频最多记几段范围 */
export const RANGES_MAX = 12

/** 截帧弹窗记住的设置：自动截帧方式、张数、增强方式、选中的范围 */
export const VideoPrefs = z.object({
  mode: z.enum(['uniform', 'scene', 'screen']).catch('scene'),
  count: z.number().int().min(1).max(24).catch(8),
  method: z.string().max(200).catch(''),
  /** 选中的范围 id；空是整段 */
  range: z.string().max(40).catch(''),
})
export type VideoPrefs = z.infer<typeof VideoPrefs>
export const DEFAULT_PREFS: VideoPrefs = { mode: 'scene', count: 8, method: '', range: '' }

/** 范围的显示名：没起名时叫「范围 n」 */
export const rangeLabel = (r: NamedRange, i: number, unnamed: (n: number) => string) => r.name || unnamed(i + 1)

// ---------- 相似帧去重 ----------

/** 感知哈希的尺寸：9×8 的灰度图，每行相邻两点比较，得到 64 位 */
export const HASH_W = 9
export const HASH_H = 8

/** 差值哈希（dHash）：左边比右边亮记 1。对缩放、轻微压缩、亮度整体变化不敏感，画面内容变了才会变 */
export function dHash(gray: Uint8Array): string {
  if (gray.length < HASH_W * HASH_H) return ''
  let bits = ''
  for (let y = 0; y < HASH_H; y++)
    for (let x = 0; x < HASH_W - 1; x++) bits += gray[y * HASH_W + x] > gray[y * HASH_W + x + 1] ? '1' : '0'
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/** 两个哈希差几位；长度不一样（算不出来）时当成完全不同 */
export function hamming(a: string, b: string): number {
  if (!a || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

/** 差几位以内算「几乎一样」：64 位里 6 位，录屏里只有光标动了一下、输入框多了一个字的画面会被认成一样 */
export const SIMILAR_BITS = 6

/**
 * 相似帧去重：按时间顺序把哈希相近的相邻帧归成一组，每组只留一张——有手动帧留手动帧（用户自己截的不删），
 * 都是自动帧时留最清楚的。返回要删的帧 id（只会是自动帧）
 */
export function similarToDrop(
  frames: { id: string; time: number; source: 'manual' | 'auto'; hash: string; sharp: number }[],
  bits = SIMILAR_BITS,
): string[] {
  const sorted = [...frames].sort((a, b) => a.time - b.time)
  const groups: (typeof sorted)[] = []
  for (const f of sorted) {
    const g = groups[groups.length - 1]
    // 和组里最后一张比：画面慢慢变化时，首尾可能差很多，但每一步都很小，照样算一组（录屏里的连续滚动不算重复）
    if (g && f.hash && hamming(g[g.length - 1].hash, f.hash) <= bits && hamming(g[0].hash, f.hash) <= bits * 2)
      g.push(f)
    else groups.push([f])
  }
  const drop: string[] = []
  for (const g of groups) {
    if (g.length < 2) continue
    const keep = g.find((f) => f.source === 'manual') ?? g.reduce((a, b) => (b.sharp > a.sharp ? b : a))
    for (const f of g) if (f !== keep && f.source === 'auto') drop.push(f.id)
  }
  return drop
}

// ---------- 帧差高亮 ----------

/** 帧差用的灰度图宽度：够看出哪一块变了，又快 */
export const DIFF_W = 192

export interface DiffBox {
  /** 相对图片宽高的比例 */
  x: number
  y: number
  w: number
  h: number
}

/**
 * 两张同尺寸灰度图哪里变了：逐点差值超过 threshold 的算变化点，按 cell×cell 的格子数变化点，
 * 变化点占格子 minRatio 以上的格子算「变了」，相连的格子合成一个框（八邻接）。
 * 返回按面积从大到小排的框，最多 max 个；整张都变了（切镜头）时返回一个整图的框
 */
export function diffBoxes(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  o: { threshold?: number; cell?: number; minRatio?: number; max?: number } = {},
): DiffBox[] {
  const threshold = o.threshold ?? 28
  const cell = o.cell ?? 8
  const minRatio = o.minRatio ?? 0.08
  const max = o.max ?? 8
  if (!width || !height || a.length < width * height || b.length < width * height) return []
  const cols = Math.ceil(width / cell)
  const rows = Math.ceil(height / cell)
  const hot = new Uint8Array(cols * rows)
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      let changed = 0
      let total = 0
      for (let y = cy * cell; y < Math.min(height, (cy + 1) * cell); y++)
        for (let x = cx * cell; x < Math.min(width, (cx + 1) * cell); x++) {
          total++
          if (Math.abs(a[y * width + x] - b[y * width + x]) > threshold) changed++
        }
      if (total && changed / total >= minRatio) hot[cy * cols + cx] = 1
    }
  const seen = new Uint8Array(cols * rows)
  const boxes: (DiffBox & { area: number })[] = []
  for (let i = 0; i < hot.length; i++) {
    if (!hot[i] || seen[i]) continue
    let x0 = cols
    let y0 = rows
    let x1 = -1
    let y1 = -1
    let area = 0
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()!
      const cx = j % cols
      const cy = Math.floor(j / cols)
      area++
      x0 = Math.min(x0, cx)
      y0 = Math.min(y0, cy)
      x1 = Math.max(x1, cx)
      y1 = Math.max(y1, cy)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const k = ny * cols + nx
          if (hot[k] && !seen[k]) {
            seen[k] = 1
            stack.push(k)
          }
        }
    }
    boxes.push({
      x: (x0 * cell) / width,
      y: (y0 * cell) / height,
      w: Math.min(1, ((x1 + 1) * cell) / width) - (x0 * cell) / width,
      h: Math.min(1, ((y1 + 1) * cell) / height) - (y0 * cell) / height,
      area,
    })
  }
  // 大半张都变了：是切镜头或整屏跳转，框一堆小块没意义，给一个整图的框
  const hotCount = hot.reduce((n, v) => n + v, 0)
  if (hotCount > hot.length * 0.6) return [{ x: 0, y: 0, w: 1, h: 1 }]
  return boxes
    .sort((p, q) => q.area - p.area)
    .slice(0, max)
    .map(({ area: _a, ...b }) => b)
}

/** 帧差的框转成标注（红框）：用户想把「这里变了」直接标到图上发给 AI */
export const boxesToShapes = (boxes: DiffBox[], color: string = SHAPE_COLORS[0]): FrameShape[] =>
  boxes.map((b) => ({ kind: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, color }))
