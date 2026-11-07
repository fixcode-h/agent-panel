import { t } from './i18n.ts'
import type { ComfyNode, LocalFile, LocalModel } from './local-image.ts'

/**
 * 画质修复类的内置 ComfyUI 工作流：超分（提升清晰度）、去噪点、画质修复。
 * 视频截帧的「画面增强」直接用它们（用户 2026-11-07 要的：ComfyUI 要有现成能用的工作流，能提清晰度、去噪点），
 * 设计页的工作流链里也能当处理段用。
 *
 * 模型和接法都取自 ComfyUI 官方模板（Comfy-Org/workflow_templates）：
 * - Real-ESRGAN：utility-gan_upscaler（UpscaleModelLoader → ImageUpscaleWithModel），64 MB，几秒一张，
 *   训练时就带了噪点、压缩块、模糊的退化，放大的同时把这些去掉；
 * - SeedVR2 3B Int8：utility_seedvr2_3b_int8_upscale_image（一步扩散的修复模型），3.7 GB，
 *   去噪、去模糊、补细节都比 GAN 强，但慢、要显存。
 *
 * 这个文件只引用 local-image.ts 的类型，不在运行时引用它：local-image.ts 要把这里的清单并进自己的数组，
 * 互相在运行时引用会成环。输入图占位符由调用方传进来。
 */

const HF = 'https://huggingface.co'

/** 模型文件：地址和大小照官方模板说明里的 Model Links */
export const RESTORE_FILES: LocalFile[] = [
  {
    id: 'realesrgan-x4',
    dir: 'upscale_models',
    file: 'RealESRGAN_x4plus.safetensors',
    url: `${HF}/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors`,
    gb: 0.064,
  },
  {
    id: 'seedvr2-3b',
    dir: 'diffusion_models',
    file: 'seedvr2_3b_int8_convrot.safetensors',
    url: `${HF}/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors`,
    gb: 3.22,
  },
  {
    id: 'seedvr2-vae',
    dir: 'vae',
    file: 'seedvr2_ema_vae_fp16.safetensors',
    url: `${HF}/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors`,
    gb: 0.48,
  },
]

export const RESTORE_MODELS: LocalModel[] = [
  {
    id: 'realesrgan',
    name: 'Real-ESRGAN x4plus',
    family: 'esrgan',
    category: 'process',
    files: ['realesrgan-x4'],
    vram: 2,
    use: t('提升清晰度、去噪点：放大的同时去掉噪点、压缩块和轻微模糊，64 MB、几秒一张；视频截帧的画面增强首选'),
    license: 'BSD-3-Clause',
    base: 1024,
    natural: true,
  },
  {
    id: 'seedvr2-3b',
    name: 'SeedVR2 3B Int8',
    family: 'seedvr2',
    category: 'process',
    files: ['seedvr2-3b', 'seedvr2-vae'],
    vram: 12,
    use: t('画质修复：一步扩散模型，去噪、去模糊、补细节都比 Real-ESRGAN 强，适合很糊、噪点很重的画面；慢，要显存'),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
]

const n = (class_type: string, inputs: Record<string, unknown>): ComfyNode => ({ class_type, inputs })
const fileOf = (id: string) => RESTORE_FILES.find((f) => f.id === id)!.file

/**
 * Real-ESRGAN 是 4 倍模型：先放大 4 倍（同时去噪、去压缩块），再按 scale 缩回去。
 * scale = 1 就是「尺寸不变、只去噪」，2 是「清晰度 2 倍」。缩小用 area，比 lanczos 少振铃
 */
export function esrganGraph(image: string, scale: 1 | 2 | 4): Record<string, ComfyNode> {
  const g: Record<string, ComfyNode> = {
    image: n('LoadImage', { image }),
    model: n('UpscaleModelLoader', { model_name: fileOf('realesrgan-x4') }),
    up: n('ImageUpscaleWithModel', { upscale_model: ['model', 0], image: ['image', 0] }),
  }
  if (scale === 4) return { ...g, save: n('SaveImage', { images: ['up', 0], filename_prefix: 'agent-panel' }) }
  return {
    ...g,
    down: n('ImageScaleBy', { image: ['up', 0], upscale_method: 'area', scale_by: scale / 4 }),
    save: n('SaveImage', { images: ['down', 0], filename_prefix: 'agent-panel' }),
  }
}

/**
 * SeedVR2 画质修复：先把图缩放到约 megapixels 百万像素（小图放大、大图不再放大），再走官方模板子图的接法
 * （SeedVR2Preprocess → VAEEncodeTiled → SeedVR2Conditioning → KSampler 1 步 → VAEDecodeTiled → SeedVR2PostProcessing）。
 * 官方模板用 ResizeImageMaskNode 放大 4 倍，那是给小图用的；视频帧常是 1080p，再放 4 倍显存和时间都吃不消，
 * 而且发给模型看的图本来就会被缩到 1.5K 左右，所以按总像素定大小。调色用 lab（最贴近原图的颜色）
 */
export function seedvr2Graph(image: string, megapixels = 2): Record<string, ComfyNode> {
  const tiled = { tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 }
  return {
    image: n('LoadImage', { image }),
    resize: n('ImageScaleToTotalPixels', {
      image: ['image', 0],
      upscale_method: 'lanczos',
      megapixels,
      resolution_steps: 1,
    }),
    pre: n('SeedVR2Preprocess', { resized_images: ['resize', 0] }),
    unet: n('UNETLoader', { unet_name: fileOf('seedvr2-3b'), weight_dtype: 'default' }),
    vae: n('VAELoader', { vae_name: fileOf('seedvr2-vae') }),
    enc: n('VAEEncodeTiled', { pixels: ['pre', 0], vae: ['vae', 0], ...tiled }),
    cond: n('SeedVR2Conditioning', { model: ['unet', 0], vae_conditioning: ['enc', 0] }),
    sample: n('KSampler', {
      model: ['unet', 0],
      positive: ['cond', 0],
      negative: ['cond', 1],
      latent_image: ['enc', 0],
      seed: '{{seed}}',
      steps: 1,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
    }),
    dec: n('VAEDecodeTiled', { samples: ['sample', 0], vae: ['vae', 0], ...tiled }),
    post: n('SeedVR2PostProcessing', {
      images: ['dec', 0],
      original_resized_images: ['resize', 0],
      color_correction_method: 'lab',
    }),
    save: n('SaveImage', { images: ['post', 0], filename_prefix: 'agent-panel' }),
  }
}

/** 画质修复类内置工作流的定义（local-image.ts 用 processingBuiltin 包成 ComfyWorkflow） */
export const restoreWorkflowDefs = (image: string) => [
  {
    id: 'restore-esrgan-2x',
    name: t('提升清晰度 · 2 倍（Real-ESRGAN）'),
    description: t(
      '模型放大 2 倍，同时去掉噪点、压缩块和轻微模糊：截图、视频帧、低清素材变清楚时用；64 MB 模型，几秒一张',
    ),
    model: 'realesrgan',
    graph: esrganGraph(image, 2),
  },
  {
    id: 'restore-esrgan-denoise',
    name: t('去噪点 · 尺寸不变（Real-ESRGAN）'),
    description: t('尺寸不变，只去掉噪点、压缩块和色带：暗光录像、高压缩视频、颗粒重的截图用'),
    model: 'realesrgan',
    graph: esrganGraph(image, 1),
  },
  {
    id: 'restore-esrgan-4x',
    name: t('提升清晰度 · 4 倍（Real-ESRGAN）'),
    description: t('模型放大 4 倍：图很小（几百像素）时用；图本来就大时 4 倍会很大，优先用 2 倍'),
    model: 'realesrgan',
    graph: esrganGraph(image, 4),
  },
  {
    id: 'restore-seedvr2',
    name: t('画质修复（SeedVR2）'),
    description: t(
      '一步扩散的修复模型：去噪、去模糊、补细节，很糊或噪点很重的画面用；缩放到约 200 万像素输出，要 12GB 左右显存',
    ),
    model: 'seedvr2-3b',
    graph: seedvr2Graph(image),
  },
]
