import { readFile, writeFile } from 'node:fs/promises'
import { crop, decodePng, encodePng, removeFlatBackground, resize, type Img } from './image.ts'
import { similarity } from '../shared/restore/similarity.ts'
import type { Design, DesignImage } from '../shared/design.ts'
import { t } from '../shared/i18n.ts'
import { matchParts, partsPrompt, splitParts } from '../shared/restore/parts.ts'
import type { RestoreElement } from '../shared/restore/schema.ts'

/**
 * 切图默认从原画里抠，不重新画：重新生成每次都和原画不一样（Icon 永远对不上），
 * 原画里那一块才是用户要的样子。ref 是设计稿像素，按原画的实际分辨率换算后裁，不先把整张缩到设计稿尺寸
 * （原画比设计稿大时不丢细节）。透明的元素（图标、装饰）去掉平底；九宫格和不透明的底图原样保留。
 * 结果按这张图在界面上的尺寸输出，不留白、不按比例缩进去：框就是控件的位置，内容要正好填满框
 */
export function cropTemplate(
  tpl: Img,
  designSize: { X: number; Y: number },
  img: Pick<DesignImage, 'width' | 'height' | 'transparent' | 'nineSlice'> & { ref: NonNullable<DesignImage['ref']> },
): Img | undefined {
  const sx = tpl.width / designSize.X
  const sy = tpl.height / designSize.Y
  const x = Math.max(0, Math.round(img.ref.x * sx))
  const y = Math.max(0, Math.round(img.ref.y * sy))
  const w = Math.min(tpl.width - x, Math.round(img.ref.w * sx))
  const h = Math.min(tpl.height - y, Math.round(img.ref.h * sy))
  if (w < 2 || h < 2) return undefined
  let out = crop(tpl, x, y, w, h)
  if (img.transparent && !img.nineSlice) out = removeFlatBackground(out)
  return resize(out, img.width, img.height)
}

/** 读模板文件再抠；模板不是 PNG（解不开）或区域落在图外时返回 undefined，调用方退回按描述生成 */
export async function cropTemplateFile(
  file: string,
  designSize: { X: number; Y: number },
  img: Pick<DesignImage, 'width' | 'height' | 'transparent' | 'nineSlice' | 'ref'>,
): Promise<Buffer | undefined> {
  if (!img.ref) return undefined
  const tpl = decodePng(await readFile(file).catch(() => Buffer.alloc(0)))
  const out = tpl && cropTemplate(tpl, designSize, { ...img, ref: img.ref })
  return out ? encodePng(out) : undefined
}

/** 精修出来的图和原画抠的那块有多像（0~1）；解不开时返回 undefined（不打分，不拦） */
export function cropScore(cropped: Buffer, out: Buffer) {
  const a = decodePng(cropped)
  const b = decodePng(out)
  return a && b ? similarity(a, b) : undefined
}

/**
 * 精修完给每一版打分（和原画抠的那块比），选分最高、过门槛的那版；都没过门槛时选回原画抠的那版。
 * low 是没过门槛时最高的分（调用方在对话里说明），过了时为 undefined
 */
export async function pickRefined(
  dir: string,
  img: Pick<DesignImage, 'variants' | 'selected'>,
  from: Buffer,
  min: number,
): Promise<{ variants: DesignImage['variants']; selected: number; low?: number }> {
  const variants = await Promise.all(
    img.variants.map(async (v) => {
      if (v.score !== undefined || v.source === 'upload') return v
      const buf = await readFile(`${dir}/${v.file}`).catch(() => undefined)
      const score = buf ? cropScore(from, buf) : undefined
      return score === undefined ? v : { ...v, score: Math.round(score * 1000) / 1000 }
    }),
  )
  let best = -1
  variants.forEach((v, i) => {
    if (v.source !== 'crop' && (v.score ?? 0) >= min && (best < 0 || (v.score ?? 0) > (variants[best].score ?? 0)))
      best = i
  })
  if (best >= 0) return { variants, selected: best }
  const scored = variants.filter((v) => v.source !== 'crop' && v.score !== undefined).map((v) => v.score!)
  const crop = variants.map((v) => v.source).lastIndexOf('crop')
  return {
    variants,
    selected: crop >= 0 ? crop : img.selected,
    low: scored.length ? Math.max(...scored) : undefined,
  }
}

type RefImage = Pick<DesignImage, 'id' | 'name' | 'width' | 'height' | 'transparent' | 'nineSlice' | 'ref'>

/** 写了 ref 的切图当成元素（模板像素）：透明且不是九宫格的当图标，其余当容器 */
function refElements(tpl: Img, designSize: { X: number; Y: number }, images: RefImage[]): RestoreElement[] {
  const sx = tpl.width / designSize.X
  const sy = tpl.height / designSize.Y
  return images.flatMap((i) =>
    i.ref
      ? [
          {
            id: i.id,
            kind: i.transparent && !i.nineSlice ? ('icon' as const) : ('panel' as const),
            name: i.name,
            box: { x: i.ref.x * sx, y: i.ref.y * sy, w: Math.max(1, i.ref.w * sx), h: Math.max(1, i.ref.h * sy) },
            confidence: 1,
            source: 'detect' as const,
          },
        ]
      : [],
  )
}

/** 出拆件图的提示词：模板当参考图，元素清单取写了 ref 的切图 */
export function templatePartsPrompt(
  tpl: Img,
  designSize: { X: number; Y: number },
  kind: 'game' | 'web' | undefined,
  images: RefImage[],
) {
  return partsPrompt(kind, refElements(tpl, designSize, images), tpl)
}

/**
 * 模板模式的切图从拆件图里切：每张写了 ref 的切图和拆件图里的件对上，缩放到它在界面上的尺寸。
 * 对不上的不在结果里，调用方照旧从模板里抠。返回 图片 id → PNG 和对上的分数
 */
export function partCrops(tpl: Img, sheet: Img, designSize: { X: number; Y: number }, images: RefImage[]) {
  const elements = refElements(tpl, designSize, images)
  const m = matchParts(tpl, elements, splitParts(sheet))
  const out = new Map<string, { png: Buffer; score: number }>()
  for (const i of images) {
    const hit = m.get(i.id)
    if (hit)
      out.set(i.id, { png: encodePng(resize(hit.img, i.width, i.height)), score: Math.round(hit.score * 1000) / 1000 })
  }
  return out
}

/** 模板模式出拆件图并切：sheetFile 已经有就直接读，没有就 generate 一张（模板当参考图）存到 sheetFile */
export async function templatePartCrops(o: {
  tplFile: string
  sheetFile: string
  design: Pick<Design, 'designSize' | 'kind' | 'images'>
  want: RefImage[]
  generate: (prompt: string, ref: string) => Promise<Buffer>
}) {
  const tpl = decodePng(await readFile(o.tplFile).catch(() => Buffer.alloc(0)))
  if (!tpl) return undefined
  let buf: Buffer | undefined = await readFile(o.sheetFile).catch(() => undefined)
  if (!buf) {
    buf = await o.generate(templatePartsPrompt(tpl, o.design.designSize, o.design.kind, o.design.images), o.tplFile)
    await writeFile(o.sheetFile, buf)
  }
  const sheet = decodePng(buf)
  if (!sheet) throw new Error(t('拆件图不是 PNG，读不出来'))
  return partCrops(tpl, sheet, o.design.designSize, o.want)
}
