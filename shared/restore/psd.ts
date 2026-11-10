import type { Color, Layer, Psd } from 'ag-psd'
import { blank, paste, type Img } from '../raster.ts'
import type { ElementKind, ElementText, RestoreElement } from './schema.ts'
import { kindPrefix, nameAll } from './detect.ts'

/**
 * PSD 导入：图层就是元素，图层的像素就是切图，位置一个像素都不用猜。
 * 图层 / 组的命名约定（参照 psd2fgui、PSD → UMG 插件）：
 * - 前缀定类型：`Btn_`、`Panel_`、`Slot_`、`Icon_`、`Txt_`、`Bar_`、`Input_`、`Deco_`、`Bg_`（大小写都行）；
 * - 按钮组里 `@normal` `@hover` `@pressed` `@disabled` 结尾的图层是四种状态；
 * - 容器组里叫 `bg` / `背景` / `底` 的图层（或最底下、几乎铺满整组的那张）是容器自己的底图；
 * - 名字里带 `#9` 的按九宫格切。
 * 没有约定的组只当文件夹，里面的图层按大小猜类型；文字图层直接读内容、字号、颜色、对齐。
 * 这里只认 ag-psd 解析出来的对象，读文件、存图片由调用方做（服务端、演示版各自的存法）
 */

export interface PsdLayerImage {
  /** 元素里 layer / states 填的就是这个 key，调用方存成文件后换成文件名 */
  key: string
  img: Img
}

export interface PsdImport {
  width: number
  height: number
  /** 合成图：PSD 里存的那张；没存（关了「最大兼容」）就按图层叠出来 */
  composite: Img
  elements: RestoreElement[]
  layers: PsdLayerImage[]
  /** 读不了的东西（图层样式、蒙版、混合模式）：写在原画那一步的卡上 */
  warnings: string[]
}

const KINDS: [RegExp, ElementKind][] = [
  [/^bg[_\s-]/i, 'background'],
  [/^(btn|button)[_\s-]/i, 'button'],
  [/^panel[_\s-]/i, 'panel'],
  [/^slot[_\s-]/i, 'slot'],
  [/^icon[_\s-]/i, 'icon'],
  [/^(txt|text)[_\s-]/i, 'text'],
  [/^bar[_\s-]/i, 'bar'],
  [/^input[_\s-]/i, 'input'],
  [/^deco[_\s-]/i, 'decoration'],
]
const CONTAINERS: ElementKind[] = ['panel', 'button', 'slot', 'bar', 'input']
const STATE = /@(normal|hover|pressed|disabled)\s*$/i
const BG_NAME = /^(bg|background|背景|底|底图)$/i

const kindOfName = (name: string) => KINDS.find(([re]) => re.test(name.trim()))?.[1]

/** 控件名：只留英文、数字、下划线，补上类型前缀；中文名（「图层 1」）留空，后面统一按类型编号 */
function cleanName(raw: string, kind: ElementKind) {
  const base = raw.replace(STATE, '').replace(/#9/g, '').trim()
  if (!/^[A-Za-z][\w\s-]*$/.test(base)) return ''
  const words = base.split(/[\s_-]+/).filter(Boolean)
  const pre = kindPrefix(kind)
  const head = words[0] && kindOfName(`${words[0]}_`) ? words.slice(1) : words
  const body = head.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
  return body ? `${pre}_${body}` : ''
}

function hex(c: Color | undefined) {
  if (!c) return '#FFFFFFFF'
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  if ('r' in c) return `#${h(c.r)}${h(c.g)}${h(c.b)}FF`
  if ('fr' in c) return `#${h(c.fr * 255)}${h(c.fg * 255)}${h(c.fb * 255)}FF`
  return '#FFFFFFFF'
}

interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

const union = (list: Bounds[]): Bounds | undefined => {
  if (!list.length) return undefined
  const x0 = Math.min(...list.map((b) => b.x))
  const y0 = Math.min(...list.map((b) => b.y))
  const x1 = Math.max(...list.map((b) => b.x + b.w))
  const y1 = Math.max(...list.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function importPsd(psd: Psd): PsdImport {
  const W = psd.width
  const H = psd.height
  const elements: RestoreElement[] = []
  const layers: PsdLayerImage[] = []
  const warnings = new Set<string>()
  let n = 0
  const id = () => `p${++n}`

  /** 图层的像素（裁到画布里、乘上不透明度）和它在画布上的位置；空图层返回 undefined */
  const pixelsOf = (l: Layer): { img: Img; box: Bounds } | undefined => {
    const d = l.imageData
    if (!d || !d.width || !d.height) return undefined
    const left = l.left ?? 0
    const top = l.top ?? 0
    const x0 = Math.max(0, left)
    const y0 = Math.max(0, top)
    const x1 = Math.min(W, left + d.width)
    const y1 = Math.min(H, top + d.height)
    if (x1 <= x0 || y1 <= y0) return undefined
    const w = x1 - x0
    const h = y1 - y0
    const out = new Uint8Array(w * h * 4)
    const op = l.opacity ?? 1
    const src = d.data
    // 16 位、32 位的通道统一缩到 0~255
    const k = src instanceof Uint16Array ? 1 / 257 : src instanceof Float32Array ? 255 : 1
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = ((y + y0 - top) * d.width + (x + x0 - left)) * 4
        const o = (y * w + x) * 4
        out[o] = src[s] * k
        out[o + 1] = src[s + 1] * k
        out[o + 2] = src[s + 2] * k
        out[o + 3] = src[s + 3] * k * op
      }
    if (l.effects && Object.keys(l.effects).length) warnings.add('style')
    if (l.mask) warnings.add('mask')
    if (l.blendMode && l.blendMode !== 'normal' && l.blendMode !== 'pass through') warnings.add('blend')
    return { img: { width: w, height: h, data: out }, box: { x: x0, y: y0, w, h } }
  }

  const keep = (img: Img) => {
    const key = `L${layers.length + 1}`
    layers.push({ key, img })
    return key
  }

  const textOf = (l: Layer): ElementText | undefined => {
    const tx = l.text
    if (!tx) return undefined
    const tf = tx.transform ?? [1, 0, 0, 1]
    const scale = Math.hypot(tf[2] ?? 0, tf[3] ?? 1) || 1
    const size = (tx.style?.fontSize ?? 16) * scale
    const j = tx.paragraphStyle?.justification ?? 'left'
    return {
      content: tx.text.replace(/\r/g, '\n').trim(),
      // 和检测出来的文字一样记笔画高（字号的 0.85），编译时再换回字号
      px: Math.round(size * 0.85),
      color: hex(tx.style?.fillColor),
      align: j === 'center' ? 'center' : j === 'right' ? 'right' : 'left',
      bold: !!tx.style?.fauxBold || /bold|heavy|black/i.test(tx.style?.font?.name ?? ''),
    }
  }

  /** 一张图层成一个元素（不是容器组里的底图、状态图） */
  const leaf = (l: Layer, hint?: ElementKind) => {
    const px = pixelsOf(l)
    const text = textOf(l)
    const box = px?.box ?? (l.text ? { x: l.left ?? 0, y: l.top ?? 0, w: 1, h: 1 } : undefined)
    if (!box) return
    const name = l.name ?? ''
    const area = (box.w * box.h) / (W * H)
    const ratio = box.w / box.h
    const kind: ElementKind = text
      ? 'text'
      : (kindOfName(name) ??
        hint ??
        (area > 0.9 ? 'background' : ratio > 0.4 && ratio < 2.5 && area < 0.04 ? 'icon' : 'decoration'))
    elements.push({
      id: id(),
      kind,
      name: cleanName(name, kind),
      box,
      confidence: 1,
      source: 'psd',
      ...(text ? { text } : {}),
      // 文字由控件画，不用图层的像素
      ...(px && !text ? { layer: keep(px.img) } : {}),
    })
  }

  const visible = (l: Layer) => !l.hidden && (l.opacity ?? 1) > 0

  const walk = (list: Layer[]) => {
    // ag-psd 的 children 从下到上：先放下面的，元素的顺序也就是叠放顺序
    for (const l of list) {
      if (!visible(l)) continue
      if (l.clipping) warnings.add('clip')
      if (!l.children) {
        leaf(l)
        continue
      }
      const kind = kindOfName(l.name ?? '')
      if (!kind || !CONTAINERS.includes(kind)) {
        // 没约定的组只是文件夹
        walk(l.children)
        continue
      }
      group(l, kind)
    }
  }

  /** 约定了类型的组：底图、状态图归它自己，其余的照常成子元素 */
  const group = (g: Layer, kind: ElementKind) => {
    const kids = (g.children ?? []).filter(visible)
    const boxes = kids.flatMap((k) => {
      const px = !k.children ? pixelsOf(k) : undefined
      return px ? [{ layer: k, ...px }] : []
    })
    const box = union(boxes.map((b) => b.box))
    if (!box) return walk(kids)
    const states: Partial<Record<'hover' | 'pressed' | 'disabled', string>> = {}
    let bg: (typeof boxes)[number] | undefined
    for (const b of boxes) {
      const m = (b.layer.name ?? '').match(STATE)
      if (!m) continue
      const s = m[1].toLowerCase()
      if (s === 'normal') bg = b
      else states[s as 'hover' | 'pressed' | 'disabled'] = keep(b.img)
    }
    bg ??= boxes.find((b) => BG_NAME.test((b.layer.name ?? '').trim()))
    // 最下面那张几乎铺满整组：是底图
    bg ??= boxes[0] && boxes[0].box.w * boxes[0].box.h >= box.w * box.h * 0.9 ? boxes[0] : undefined
    // 底图的范围就是容器的范围（状态图、外发光可能比它大一圈）
    const own = bg?.box ?? box
    elements.push({
      id: id(),
      kind,
      name: cleanName(g.name ?? '', kind),
      box: own,
      confidence: 1,
      source: 'psd',
      ...(bg ? { layer: keep(bg.img) } : {}),
      ...(Object.keys(states).length ? { states } : {}),
    })
    const used = new Set([bg?.layer, ...boxes.filter((b) => STATE.test(b.layer.name ?? '')).map((b) => b.layer)])
    walk(kids.filter((k) => !used.has(k)))
  }

  walk(psd.children ?? [])

  // 要有一个铺满的背景元素：没有背景图层时它的切图从合成图里抠（擦掉上面的元素补底）
  if (!elements.some((e) => e.kind === 'background' && e.box.w * e.box.h >= W * H * 0.9))
    elements.unshift({
      id: id(),
      kind: 'background',
      name: 'Bg_Main',
      box: { x: 0, y: 0, w: W, h: H },
      confidence: 1,
      source: 'psd',
    })
  else {
    const bg = elements.find((e) => e.kind === 'background')!
    bg.box = { x: 0, y: 0, w: W, h: H }
    bg.name ||= 'Bg_Main'
  }

  const composite = psd.imageData ? compositeOf(psd) : flatten(W, H, elements, layers)
  nameAll(elements)
  return { width: W, height: H, composite, elements, layers, warnings: [...warnings] }
}

function compositeOf(psd: Psd): Img {
  const d = psd.imageData!
  const k = d.data instanceof Uint16Array ? 1 / 257 : d.data instanceof Float32Array ? 255 : 1
  const out = new Uint8Array(d.width * d.height * 4)
  for (let i = 0; i < out.length; i++) out[i] = d.data[i] * k
  return { width: d.width, height: d.height, data: out }
}

/** 没有存合成图：按元素顺序（就是图层从下到上）把图层叠起来；文字图层没有像素，叠不出来 */
function flatten(W: number, H: number, elements: RestoreElement[], layers: PsdLayerImage[]): Img {
  const out = blank(W, H, [0, 0, 0, 0])
  const byKey = new Map(layers.map((l) => [l.key, l.img]))
  for (const e of elements) {
    const img = e.layer && byKey.get(e.layer)
    if (img) paste(out, img, Math.round(e.box.x), Math.round(e.box.y))
  }
  return out
}

/** 卡上的提醒：读不全的东西 */
export const PSD_WARNING_KEYS = ['style', 'mask', 'blend', 'clip'] as const
