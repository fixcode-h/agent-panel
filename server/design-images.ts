import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Design, DesignImage, ReplyPart } from '../shared/design.ts'
import { crop, decodePng, encodePng, resize } from './image.ts'
import { localGenerateChain } from './comfy.ts'
import { nineSliceRatios, syncBrushSlices, type SliceImage } from '../shared/umg.ts'
import { t } from '../shared/i18n.ts'

/**
 * 启动时读设计：上次面板退出时还在出图的图（generating / pending）出图任务已经没了，
 * 留着页面会一直轮询、批量重新生成也选不上它们。改成失败并写明原因，用户可以重新生成
 */
export function resetStuckImages(images: DesignImage[]): DesignImage[] {
  if (!images.some((i) => i.status === 'generating' || i.status === 'pending')) return images
  return images.map((i) =>
    i.status === 'generating' || i.status === 'pending'
      ? { ...i, status: 'failed' as const, error: t('面板重启，出图中断了，可以重新生成') }
      : i,
  )
}

/**
 * 页面保存时带回来、服务端已经没有的图（撤销了删除）：删图时文件留在设计目录里，
 * 各版只要文件名合法、文件还在就保留（以前一律清空，撤销删图后各版都没了）。返回图片 id → 保留下来的各版
 */
export async function restoredVariants(
  images: Pick<DesignImage, 'id' | 'variants'>[],
  known: Map<string, unknown>,
  dir: string,
): Promise<Map<string, DesignImage['variants']>> {
  const out = new Map<string, DesignImage['variants']>()
  for (const i of images) {
    if (known.has(i.id) || !i.variants?.length) continue
    const keep = await Promise.all(
      i.variants.map(async (v) =>
        /^[\w-]+\.(png|jpg|webp|gif)$/.test(v.file) &&
        (await stat(path.join(dir, v.file)).then(
          (x) => x.isFile(),
          () => false,
        ))
          ? v
          : null,
      ),
    )
    out.set(
      i.id,
      keep.filter((v): v is NonNullable<typeof v> => !!v),
    )
  }
  return out
}

/**
 * 图片的九宫格和画刷的九宫格参数对齐：图片的 nineSlice 统一成 0~1 的比例（老数据把像素直接写进去过），
 * 引用它的 Box/Border 画刷的 Margin 用同一组比例、ImageSize 用图片实际尺寸。
 * 加载、保存和 AI 改完都跑一遍，渲染和导出拿到的就是同一组数，不会切到边框花纹。
 */
export function normalizeSlices(d: Design): Design {
  const imgs = new Map<string, SliceImage>()
  for (const i of d.images) {
    const v = i.variants[Math.min(Math.max(0, i.selected), i.variants.length - 1)]
    const width = v?.width || i.width
    const height = v?.height || i.height
    const nine = nineSliceRatios(i.nineSlice, width, height)
    const slice = nine && (nine.Left || nine.Top || nine.Right || nine.Bottom) ? nine : undefined
    imgs.set(i.id, { id: i.id, width, height, transparent: i.transparent, nineSlice: slice })
    i.nineSlice = slice
  }
  d.root = syncBrushSlices(d.root, imgs)
  d.components = d.components.map((c) => ({ ...c, Root: syncBrushSlices(c.Root, imgs) }))
  return d
}

/** 存进消息的分段：工具都已结束，去掉空的段 */
export function finalParts(parts: ReplyPart[]): ReplyPart[] | undefined {
  const list = parts
    .map((p) => ({ ...p, tools: p.tools.map((x) => ({ ...x, running: false })) }))
    .filter((p) => p.text || p.thinking?.trim() || p.tools.length)
  return list.length ? list : undefined
}

/**
 * 从确认的模板里裁出一张切图对应的那一块（模板先缩放到设计稿尺寸，ref 是设计稿像素），存成 PNG。
 * 生成切图时拿它做参考：只给整张模板时，模型常把别处的花纹、文字一起画进来，形状也对不上。
 * 模板不是 PNG、或者区域落在图外时返回 undefined，调用方退回只带整张模板
 */
export async function templateCrop(
  file: string,
  designSize: { X: number; Y: number },
  ref: { x: number; y: number; w: number; h: number },
): Promise<Buffer | undefined> {
  const img = decodePng(await readFile(file).catch(() => Buffer.alloc(0)))
  if (!img) return undefined
  const full = resize(img, designSize.X, designSize.Y)
  const x = Math.max(0, Math.min(Math.round(ref.x), designSize.X - 1))
  const y = Math.max(0, Math.min(Math.round(ref.y), designSize.Y - 1))
  const w = Math.min(Math.round(ref.w), designSize.X - x)
  const h = Math.min(Math.round(ref.h), designSize.Y - y)
  if (w < 4 || h < 4) return undefined
  return encodePng(crop(full, x, y, w, h))
}

/** 内置的「图生图 · 风格复刻」工作流：从模板裁下的那一块出发生成切图 */
const IMG2IMG_WORKFLOW = 'game-img2img'

/**
 * 本机 ComfyUI 从模板的局部图生图：降噪 0.55，保留模板里的形状和配色、重新画干净（去掉压在上面的文字、背景）。
 * 走工作流链（一段的链），进度、取消、队列都和别的本机出图一样
 */
export async function templateImg2Img(
  o: {
    crop: Buffer
    prompt: string
    negative: string
    width: number
    height: number
    count: number
    onImage: (b: Buffer) => void
    onProgress: (text: string) => void
  },
  signal: AbortSignal,
) {
  await localGenerateChain(
    {
      chain: {
        id: 'design-template-ref',
        name: '',
        steps: [{ workflowId: IMG2IMG_WORKFLOW, prompt: '', denoise: 0.55 }],
        updatedAt: new Date().toISOString(),
      },
      image: o.crop,
      prompt: o.prompt,
      negative: o.negative,
      width: o.width,
      height: o.height,
      count: o.count,
      onImage: o.onImage,
      onProgress: o.onProgress,
    },
    signal,
  )
}
