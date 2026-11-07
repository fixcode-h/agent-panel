import type { Design } from '@shared/design'
import type { Img } from '@shared/raster'
import { DEFAULT_THRESHOLDS } from '@shared/restore/thresholds'
import { labelNumbers, type LabelReply } from '@shared/restore/label'
import { RESTORE_STEPS, RestoreElement, stepOf, type RestoreStep } from '@shared/restore/schema'
import { acceptDiff, confirmStep, editElements, runStep, setSource, stateOf, stepName } from '@shared/restore/steps'
import { kindPrefix } from '@shared/restore/detect'
import { demoMs } from './demo-speed'

/**
 * 演示版的「照原画还原」：检测、抠图、编译、校验都是 shared 里的同一套算法，直接在浏览器里跑；
 * 原画用 canvas 解成像素，切图存成 data URL。模型标注换成按位置猜的假标注（示例原画上的字照抄）
 */

type Full = Design & { job: unknown }
const fail = (msg: string): never => {
  throw new Error(msg)
}
const now = () => new Date().toISOString()

async function decode(url: string): Promise<Img> {
  const im = new Image()
  im.src = url
  await im.decode()
  const c = document.createElement('canvas')
  c.width = im.naturalWidth || 1600
  c.height = im.naturalHeight || 900
  const g = c.getContext('2d')!
  g.drawImage(im, 0, 0, c.width, c.height)
  const data = g.getImageData(0, 0, c.width, c.height).data
  return { width: c.width, height: c.height, data: new Uint8Array(data.buffer.slice(0)) }
}

function encode(img: Img) {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d')!
  g.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return c.toDataURL('image/png')
}

/** 示例原画上的字（中心点 → 内容），按位置抄；用户自己上传的原画就留空，让人在界面上填 */
const SAMPLE_TEXT: [number, number, string][] = [
  [800, 175, '背 包'],
  [1066, 110, '12,480'],
  [1232, 110, '326'],
  [1095, 420, '星辉宝石'],
  [1095, 471, '蕴含星光之力的宝石，镶嵌后'],
  [1095, 497, '提升魔法攻击 +35。'],
  [1005, 628, '使用'],
  [1195, 628, '丢弃'],
  // 格子右下角的数量（示例原画 5×3 的格子，左上角在 290,230，间距 112）
  ...[3, 1, 12, 5, 99, 2, 4, 1, 7, 1, 24, 3, 1, 6, 8].map((n, i): [number, number, string] => [
    290 + (i % 5) * 112 + 86,
    230 + Math.floor(i / 5) * 112 + 89,
    String(n),
  ]),
]

function fakeLabel(list: RestoreElement[]): LabelReply {
  const nums = labelNumbers(list)
  const seen = new Map<string, number>()
  const elements = list.flatMap((e) => {
    const n = nums.get(e.id)
    if (!n) return []
    const cx = e.box.x + e.box.w / 2
    const cy = e.box.y + e.box.h / 2
    // 取离得最近的那条：格子的数量挨得近，不能拿第一条碰上的
    const dist = ([x, y]: [number, number, string]) => Math.abs(x - cx) + Math.abs(y - cy)
    const hit =
      e.box.h < 44
        ? SAMPLE_TEXT.filter(([x, y]) => Math.abs(x - cx) < 60 && Math.abs(y - cy) < 16).sort(
            (a, b) => dist(a) - dist(b),
          )[0]
        : undefined
    const kind = hit ? 'text' : e.kind
    const base = hit
      ? 'Text'
      : kind === 'slot'
        ? 'Item'
        : kind === 'icon'
          ? 'Item'
          : kind === 'button'
            ? 'Action'
            : 'Main'
    const k = (seen.get(`${kind}${base}`) ?? 0) + 1
    seen.set(`${kind}${base}`, k)
    return [{ n, kind, name: `${kindPrefix(kind)}_${base}${k > 1 ? k : ''}`, ...(hit ? { text: hit[2] } : {}) }]
  })
  return { elements, groups: [], missing: [], note: '演示：类型和名字是按位置猜的，真实环境里由模型看图标注。' }
}

function start(d: Full, step: RestoreStep, feedback = '') {
  const r = stateOf(d)
  r.steps[step] = { ...stepOf(r, step), status: 'running', error: undefined }
  let art: Img | undefined
  setTimeout(() => {
    runStep(
      step,
      {
        design: d,
        art: async () => (art ??= await decode(r.source!.file)),
        store: async (img) => ({ file: encode(img), width: img.width, height: img.height }),
        label: async (_overlay, _prompt, list) => fakeLabel(list),
        layer: decode,
        thresholds: DEFAULT_THRESHOLDS,
        now,
      },
      feedback,
    )
      .catch((e) => {
        r.steps[step] = { ...stepOf(r, step), status: 'failed', error: (e as Error).message }
        d.messages.push({
          id: crypto.randomUUID(),
          role: 'system',
          text: `还原「${stepName(step)}」这一步失败：${(e as Error).message}`,
          at: now(),
          error: true,
        } as Design['messages'][number])
      })
      .finally(() => {
        d.updatedAt = now()
      })
  }, demoMs(400))
}

/** PSD 在浏览器里读（ag-psd 按需加载）：合成图和每个图层都存成 data URL */
async function psdSource(d: Full, data: string, name: string) {
  const [{ readPsd }, { importPsd }] = await Promise.all([import('ag-psd'), import('@shared/restore/psd')])
  const bin = atob(data.replace(/^data:[^,]*,/, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const p = importPsd(readPsd(bytes.buffer, { useImageData: true, skipThumbnail: true }))
  const files = new Map(p.layers.map((l) => [l.key, encode(l.img)]))
  const fileOf = (k: string | undefined) => (k ? files.get(k) : undefined)
  setSource(d, { kind: 'psd', file: encode(p.composite), name, width: p.width, height: p.height }, now(), {
    elements: p.elements.map((e) => ({
      ...e,
      layer: fileOf(e.layer),
      ...(e.states
        ? {
            states: {
              hover: fileOf(e.states.hover),
              pressed: fileOf(e.states.pressed),
              disabled: fileOf(e.states.disabled),
            },
          }
        : {}),
    })),
    warnings: p.warnings,
  })
  d.updatedAt = now()
  return d
}

export function demoRestore(d: Full, action: string | undefined, body: any): Full | Promise<Full> {
  const r = stateOf(d)
  if (RESTORE_STEPS.some((s) => stepOf(r, s).status === 'running') && action !== 'stop')
    fail('正在处理上一个请求，等它完成或先停止')
  if (action === 'source' && body.psd) return psdSource(d, String(body.data ?? ''), String(body.name ?? ''))
  if (action === 'source') {
    const url = String(body.data ?? '')
    if (!url.startsWith('data:image/')) fail('没有图片数据')
    setSource(
      d,
      {
        kind: 'image',
        file: url,
        name: String(body.name ?? ''),
        width: body.width ?? 1600,
        height: body.height ?? 900,
      },
      now(),
    )
  } else if (action === 'run') {
    if (!r.source) fail('还没有原画')
    start(d, body.step, body.feedback ?? '')
  } else if (action === 'confirm') {
    const next = confirmStep(d, body.step)
    if (next) start(d, next)
  } else if (action === 'elements') {
    editElements(
      d,
      (body.elements ?? []).map((e: unknown) => RestoreElement.parse(e)),
      body.groups,
    )
  } else if (action === 'accept') acceptDiff(d, String(body.element ?? ''), body.on !== false, DEFAULT_THRESHOLDS)
  d.updatedAt = now()
  return d
}
