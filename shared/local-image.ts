import { z } from 'zod'
import { t } from './i18n.ts'

/**
 * 本机生图：用 ComfyUI 跑开源图片模型。
 * 选 ComfyUI 是因为它有完整的 HTTP 接口（提交工作流、取结果），同一套接口能跑 Z-Image、FLUX、SDXL、Qwen-Image，
 * 新模型出来官方当天就支持；Fooocus、WebUI 这类偏手动操作，接口弱，也跟不上新模型。
 *
 * 模型文件和工作流参数都取自 ComfyUI 官方的工作流模板（Comfy-Org/workflow_templates），下载地址是 Hugging Face 上的官方重新打包版。
 */

/** ComfyUI/models 下的目录 */
export type LocalDir = 'checkpoints' | 'diffusion_models' | 'text_encoders' | 'vae' | 'loras'

export interface LocalFile {
  id: string
  dir: LocalDir
  file: string
  url: string
  /** 大约多少 GB，给用户估计下载量；实际大小以下载时为准 */
  gb: number
}

const HF = 'https://huggingface.co'

/** 模型用到的文件；几个模型共用的（例如 Qwen3-4B 文本编码器）只下载一次 */
export const LOCAL_FILES: LocalFile[] = [
  {
    id: 'zimage-unet',
    dir: 'diffusion_models',
    file: 'z_image_turbo_bf16.safetensors',
    url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors`,
    gb: 11.5,
  },
  {
    id: 'qwen3-4b',
    dir: 'text_encoders',
    file: 'qwen_3_4b.safetensors',
    url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`,
    gb: 7.5,
  },
  {
    id: 'flux-ae',
    dir: 'vae',
    file: 'ae.safetensors',
    url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors`,
    gb: 0.3,
  },
  {
    id: 'klein-unet',
    dir: 'diffusion_models',
    file: 'flux-2-klein-4b.safetensors',
    url: `${HF}/Comfy-Org/flux2-klein/resolve/main/split_files/diffusion_models/flux-2-klein-4b.safetensors`,
    gb: 7.8,
  },
  {
    id: 'flux2-vae',
    dir: 'vae',
    file: 'flux2-vae.safetensors',
    url: `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors`,
    gb: 0.3,
  },
  {
    id: 'schnell',
    dir: 'checkpoints',
    file: 'flux1-schnell-fp8.safetensors',
    url: `${HF}/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors`,
    gb: 17.2,
  },
  {
    id: 'sdxl',
    dir: 'checkpoints',
    file: 'sd_xl_base_1.0.safetensors',
    url: `${HF}/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors`,
    gb: 6.9,
  },
  {
    id: 'qwen-unet',
    dir: 'diffusion_models',
    file: 'qwen_image_fp8_e4m3fn.safetensors',
    url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors`,
    gb: 20.4,
  },
  {
    id: 'qwen-te',
    dir: 'text_encoders',
    file: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
    url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`,
    gb: 9.4,
  },
  {
    id: 'qwen-vae',
    dir: 'vae',
    file: 'qwen_image_vae.safetensors',
    url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors`,
    gb: 0.3,
  },
  {
    id: 'qwen-lightning',
    dir: 'loras',
    file: 'Qwen-Image-Lightning-8steps-V1.0.safetensors',
    url: `${HF}/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Lightning-8steps-V1.0.safetensors`,
    gb: 1.7,
  },
]

export type LocalFamily = 'zimage' | 'flux2klein' | 'flux1' | 'sdxl' | 'qwen'

export interface LocalModel {
  id: string
  name: string
  family: LocalFamily
  files: string[]
  /** 建议的显存（GB）；不够时 ComfyUI 会把一部分放到内存里，能跑但慢 */
  vram: number
  /** 用在哪里 */
  use: string
  license: string
  /** 出图的基准边长：按图片比例换算成这么大的面积再生成，最后缩到要的尺寸 */
  base: number
  recommended?: boolean
  /** 理解长段的自然语言描述（新一代模型）；SDXL 只认短的关键词，提示词要另外压缩 */
  natural: boolean
}

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'z-image-turbo',
    name: 'Z-Image Turbo',
    family: 'zimage',
    files: ['zimage-unet', 'qwen3-4b', 'flux-ae'],
    vram: 16,
    use: t('主力推荐：图标、按钮、面板、插画、整屏原画都好用，8 步出图，听得懂中文描述'),
    license: 'Apache-2.0',
    base: 1024,
    recommended: true,
    natural: true,
  },
  {
    id: 'flux2-klein',
    name: 'FLUX.2 [klein] 4B',
    family: 'flux2klein',
    files: ['klein-unet', 'qwen3-4b', 'flux2-vae'],
    vram: 12,
    use: t('显存 12GB 左右的首选：4 步出图最快，适合大批量的道具图标、草图和反复试风格'),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
  {
    id: 'qwen-image',
    name: 'Qwen-Image（Lightning 8 步）',
    family: 'qwen',
    files: ['qwen-unet', 'qwen-te', 'qwen-vae', 'qwen-lightning'],
    vram: 24,
    use: t('图里要有文字时用：标题、按钮上的中英文字写得准，也擅长海报式的整屏原画；体积大，要 24GB 显存'),
    license: 'Apache-2.0',
    base: 1328,
    natural: true,
  },
  {
    id: 'flux1-schnell',
    name: 'FLUX.1 [schnell]',
    family: 'flux1',
    files: ['schnell'],
    vram: 12,
    use: t('老牌快速模型：4 步出图，质感好，适合背景图和插画；单个文件，下载最省事'),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
  {
    id: 'sdxl',
    name: 'SDXL 1.0',
    family: 'sdxl',
    files: ['sdxl'],
    vram: 8,
    use: t('8GB 显存也能跑；社区的风格模型和 LoRA 最多（像素风、卡通、二次元），可以换成自己下载的同类模型'),
    license: 'OpenRAIL++',
    base: 1024,
    natural: false,
  },
]

export const localModel = (id: string) => LOCAL_MODELS.find((m) => m.id === id)
export const localFile = (id: string) => LOCAL_FILES.find((f) => f.id === id)
/** 一个模型要下载的总量（GB），不算已经有的文件 */
export const modelGb = (m: LocalModel, have: (id: string) => boolean = () => false) =>
  m.files.reduce((n, id) => n + (have(id) ? 0 : (localFile(id)?.gb ?? 0)), 0)

/** 国内访问 Hugging Face 慢或打不开：换成镜像站，路径一样 */
export const mirrorUrl = (url: string, mirror: boolean) =>
  mirror ? url.replace('https://huggingface.co/', 'https://hf-mirror.com/') : url

export type LocalGpu = 'cuda' | 'rocm' | 'mps' | 'cpu'

/** 安装、下载、修复的进度（同一时间只有一个） */
export interface LocalJob {
  id: string
  kind: 'install' | 'download' | 'repair' | 'start'
  status: 'running' | 'done' | 'failed'
  /** 当前在做什么 */
  step: string
  /** 下载进度（字节） */
  progress?: { done: number; total: number }
  model?: string
  /** 输出的最后一段 */
  log: string
  error?: string
}

export interface LocalStatus {
  /** 安装目录：软件目录下的 comfyui/ */
  dir: string
  installed: boolean
  running: boolean
  /** 用已有的 ComfyUI（设置里填了地址）时不管安装和启动 */
  external: boolean
  url: string
  python?: string
  gpu: LocalGpu
  gpuName?: string
  /** 显存（GB），检测不到时为空 */
  vram?: number
  /** 已经下载好的文件 id */
  files: string[]
  job?: LocalJob
}

/** 模型的文件都下载好了 */
export const modelReady = (m: LocalModel, st: Pick<LocalStatus, 'files' | 'external'>) =>
  st.external || m.files.every((f) => st.files.includes(f))

/** 按图片比例换算出图尺寸：面积接近 base²，边长是 64 的倍数，不超出模型能处理的范围 */
export function localSize(width: number, height: number, base: number) {
  const ar = Math.min(4, Math.max(0.25, width / height))
  const r = (v: number) => Math.min(2048, Math.max(512, Math.round(v / 64) * 64))
  return { width: r(base * Math.sqrt(ar)), height: r(base / Math.sqrt(ar)) }
}

export type ComfyNode = { class_type: string; inputs: Record<string, unknown> }
type Node = ComfyNode

/**
 * 生成 ComfyUI 的接口格式工作流（节点 id → 节点）。参数照官方模板：
 * Z-Image 8 步 res_multistep、FLUX.2 klein 4 步、Qwen-Image 加 Lightning LoRA 8 步、FLUX.1 schnell 4 步、SDXL 25 步
 */
export function localWorkflow(
  m: LocalModel,
  o: {
    prompt: string
    negative: string
    width: number | string
    height: number | string
    count: number | string
    seed: number | string
    /** 覆盖默认的步数（例如原画多走几步） */
    steps?: number
  },
): Record<string, Node> {
  const f = (id: string) => localFile(id)!.file
  const n = (class_type: string, inputs: Record<string, unknown>): Node => ({ class_type, inputs })
  const save = (images: [string, number]) => n('SaveImage', { images, filename_prefix: 'agent-panel' })
  const latent = { width: o.width, height: o.height, batch_size: o.count }
  const ksampler = (model: [string, number], steps: number, cfg: number, sampler: string, scheduler: string) =>
    n('KSampler', {
      model,
      seed: o.seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      positive: ['pos', 0],
      negative: ['neg', 0],
      latent_image: ['latent', 0],
      denoise: 1,
    })
  switch (m.family) {
    case 'zimage':
      return {
        unet: n('UNETLoader', { unet_name: f('zimage-unet'), weight_dtype: 'default' }),
        clip: n('CLIPLoader', { clip_name: f('qwen3-4b'), type: 'lumina2', device: 'default' }),
        vae: n('VAELoader', { vae_name: f('flux-ae') }),
        shift: n('ModelSamplingAuraFlow', { model: ['unet', 0], shift: 3 }),
        pos: n('CLIPTextEncode', { text: o.prompt, clip: ['clip', 0] }),
        neg: n('ConditioningZeroOut', { conditioning: ['pos', 0] }),
        latent: n('EmptySD3LatentImage', latent),
        sample: ksampler(['shift', 0], o.steps ?? 8, 1, 'res_multistep', 'simple'),
        decode: n('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] }),
        save: save(['decode', 0]),
      }
    case 'flux2klein':
      return {
        unet: n('UNETLoader', { unet_name: f('klein-unet'), weight_dtype: 'default' }),
        clip: n('CLIPLoader', { clip_name: f('qwen3-4b'), type: 'flux2', device: 'default' }),
        vae: n('VAELoader', { vae_name: f('flux2-vae') }),
        pos: n('CLIPTextEncode', { text: o.prompt, clip: ['clip', 0] }),
        neg: n('ConditioningZeroOut', { conditioning: ['pos', 0] }),
        guider: n('CFGGuider', { model: ['unet', 0], positive: ['pos', 0], negative: ['neg', 0], cfg: 1 }),
        sampler: n('KSamplerSelect', { sampler_name: 'euler' }),
        sigmas: n('Flux2Scheduler', { steps: o.steps ?? 4, width: o.width, height: o.height }),
        noise: n('RandomNoise', { noise_seed: o.seed }),
        latent: n('EmptyFlux2LatentImage', latent),
        sample: n('SamplerCustomAdvanced', {
          noise: ['noise', 0],
          guider: ['guider', 0],
          sampler: ['sampler', 0],
          sigmas: ['sigmas', 0],
          latent_image: ['latent', 0],
        }),
        decode: n('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] }),
        save: save(['decode', 0]),
      }
    case 'qwen':
      return {
        unet: n('UNETLoader', { unet_name: f('qwen-unet'), weight_dtype: 'default' }),
        clip: n('CLIPLoader', { clip_name: f('qwen-te'), type: 'qwen_image', device: 'default' }),
        vae: n('VAELoader', { vae_name: f('qwen-vae') }),
        lora: n('LoraLoaderModelOnly', { model: ['unet', 0], lora_name: f('qwen-lightning'), strength_model: 1 }),
        shift: n('ModelSamplingAuraFlow', { model: ['lora', 0], shift: 3.1 }),
        pos: n('CLIPTextEncode', { text: o.prompt, clip: ['clip', 0] }),
        neg: n('CLIPTextEncode', { text: o.negative, clip: ['clip', 0] }),
        latent: n('EmptySD3LatentImage', latent),
        sample: ksampler(['shift', 0], o.steps ?? 8, 1, 'euler', 'simple'),
        decode: n('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] }),
        save: save(['decode', 0]),
      }
    case 'flux1':
      return {
        ckpt: n('CheckpointLoaderSimple', { ckpt_name: f('schnell') }),
        pos: n('CLIPTextEncode', { text: o.prompt, clip: ['ckpt', 1] }),
        neg: n('CLIPTextEncode', { text: '', clip: ['ckpt', 1] }),
        latent: n('EmptySD3LatentImage', latent),
        sample: ksampler(['ckpt', 0], o.steps ?? 4, 1, 'euler', 'simple'),
        decode: n('VAEDecode', { samples: ['sample', 0], vae: ['ckpt', 2] }),
        save: save(['decode', 0]),
      }
    case 'sdxl':
      return {
        ckpt: n('CheckpointLoaderSimple', { ckpt_name: f('sdxl') }),
        pos: n('CLIPTextEncode', { text: o.prompt, clip: ['ckpt', 1] }),
        neg: n('CLIPTextEncode', { text: o.negative, clip: ['ckpt', 1] }),
        latent: n('EmptyLatentImage', latent),
        sample: ksampler(['ckpt', 0], o.steps ?? 25, 6.5, 'dpmpp_2m', 'karras'),
        decode: n('VAEDecode', { samples: ['sample', 0], vae: ['ckpt', 2] }),
        save: save(['decode', 0]),
      }
  }
}

/**
 * ComfyUI 工作流：接口格式的节点图（ComfyUI 里「导出（API）」得到的 JSON），参数位置写占位符，生成时换成实际的值：
 * {{prompt}} {{negative}} 是字符串里的文字；{{width}} {{height}} {{count}} {{seed}} 单独作为值时换成数字。
 * 游戏和网页各管各的；内置的不能改，可以复制一份再改
 */
export const WORKFLOW_USES = ['icon', 'button', 'panel', 'background', 'concept', 'illustration', 'any'] as const
export type WorkflowUse = (typeof WORKFLOW_USES)[number]
export const WORKFLOW_USE_LABEL: Record<WorkflowUse, string> = {
  icon: t('图标'),
  button: t('按钮'),
  panel: t('面板 / 边框'),
  background: t('背景 / 头图'),
  concept: t('整屏原画'),
  illustration: t('插画'),
  any: t('通用'),
}

export const ComfyWorkflow = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['game', 'web']),
  use: z.enum(WORKFLOW_USES).default('any'),
  description: z.string().max(2000).default(''),
  /** 用到的内置模型（LOCAL_MODELS 的 id），用来检查下载了没有；自己的模型留空 */
  model: z.string().default(''),
  /** 加在描述后面的要求（英文），针对这类资源调过的 */
  extra: z.string().max(4000).default(''),
  graph: z.record(
    z.string(),
    z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }).passthrough(),
  ),
  builtin: z.boolean().optional(),
  updatedAt: z.string().default(''),
})
export type ComfyWorkflow = z.infer<typeof ComfyWorkflow>

const P = {
  prompt: '{{prompt}}',
  negative: '{{negative}}',
  width: '{{width}}',
  height: '{{height}}',
  count: '{{count}}',
  seed: '{{seed}}',
}
const builtin = (
  id: string,
  kind: 'game' | 'web',
  use: WorkflowUse,
  model: string,
  name: string,
  description: string,
  extra: string,
  steps?: number,
): ComfyWorkflow => ({
  id,
  name,
  kind,
  use,
  model,
  description,
  extra,
  graph: localWorkflow(localModel(model)!, { ...P, steps }),
  builtin: true,
  updatedAt: '',
})

/** 内置工作流：按资源类型调过要求和步数；生成时按图片的用途自动选（自动模式） */
export const BUILTIN_WORKFLOWS: ComfyWorkflow[] = [
  builtin(
    'game-icon',
    'game',
    'icon',
    'z-image-turbo',
    t('游戏图标 · 道具与技能'),
    t('背包物品、技能、货币、状态这类小图标：单个物体居中、轮廓清楚，缩到 64~128px 也认得出'),
    'Single game item icon, one object centered with generous margin, bold readable silhouette, strong value contrast, clean dark outline, hand-painted game art, crisp edges, no background props.',
  ),
  builtin(
    'game-button',
    'game',
    'button',
    'z-image-turbo',
    t('游戏按钮'),
    t('主按钮、页签、开关：正面平视、边缘干净，留出放文字的平整区域'),
    'Game UI button seen straight on, symmetrical, clean bevel and rim light, flat readable center area left empty for a text label, no text, crisp edges.',
  ),
  builtin(
    'game-panel',
    'game',
    'panel',
    'z-image-turbo',
    t('游戏面板 · 九宫格边框'),
    t('弹窗、面板、对话框的底板和边框：四角有装饰、边和中间平整，适合九宫格拉伸'),
    'Game UI panel frame for 9-slice scaling: ornate decorated corners, straight uniform edges, plain flat even center, perfectly symmetrical, front view, no perspective.',
  ),
  builtin(
    'game-background',
    'game',
    'background',
    'z-image-turbo',
    t('游戏背景'),
    t('主界面、加载界面、关卡选择的整张背景：氛围强，中间留出放界面的空间'),
    'Atmospheric game menu background, painterly, strong depth and lighting, calm uncluttered center area where UI will be placed, no characters looking at the camera, no UI elements.',
    10,
  ),
  builtin(
    'game-concept',
    'game',
    'concept',
    'z-image-turbo',
    t('游戏界面原画'),
    t('整屏界面效果图（原画）：按设计稿比例画出完整界面，用来定风格和布局'),
    'Complete game screen UI concept art mockup, front view, polished production quality, clear layout hierarchy, consistent art style across all elements.',
    12,
  ),
  builtin(
    'game-pixel',
    'game',
    'any',
    'sdxl',
    t('像素风素材（SDXL）'),
    t('像素风、复古风的图标和小素材；显存小的电脑也能跑'),
    'pixel art, crisp pixels, limited palette, retro game sprite',
  ),
  builtin(
    'game-fast',
    'game',
    'any',
    'flux2-klein',
    t('快速草图（FLUX.2 klein）'),
    t('4 步出图，用来快速试风格、批量出草稿'),
    '',
  ),
  builtin(
    'web-illustration',
    'web',
    'illustration',
    'z-image-turbo',
    t('网页插画'),
    t('功能介绍、空状态、引导页的插画：干净、现代、配色统一'),
    'Modern clean web illustration, soft gradients, consistent flat-to-semi-flat shading, harmonious brand colors, plenty of breathing room, no text.',
  ),
  builtin(
    'web-hero',
    'web',
    'background',
    'z-image-turbo',
    t('网页头图 · 横幅'),
    t('首页大图、横幅背景：留出放标题的干净区域'),
    'Wide website hero background image, premium modern look, clean negative space on one side for a headline, subtle depth, no text, no device mockup.',
    10,
  ),
  builtin(
    'web-icon',
    'web',
    'icon',
    'flux2-klein',
    t('网页图标'),
    t('功能图标、特性图标：扁平或轻 3D，风格统一'),
    'Single modern app/web feature icon, centered, simple geometric shapes, soft 3D or flat style, consistent stroke and corner radius, clean edges.',
  ),
  builtin(
    'web-poster',
    'web',
    'any',
    'qwen-image',
    t('带文字的横幅（Qwen-Image）'),
    t('图里要写清楚的中英文字：活动横幅、海报、宣传图'),
    'Typography rendered accurately and legibly, clean layout.',
  ),
]

/** 用到的占位符都换成实际的值 */
export function fillWorkflow(
  graph: ComfyWorkflow['graph'],
  v: { prompt: string; negative: string; width: number; height: number; count: number; seed: number },
) {
  const nums: Record<string, number> = { width: v.width, height: v.height, count: v.count, seed: v.seed }
  const fill = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const whole = /^\{\{(\w+)\}\}$/.exec(x)
      if (whole && whole[1] in nums) return nums[whole[1]]
      return x.replace(/\{\{(prompt|negative)\}\}/g, (_, k: string) => (k === 'prompt' ? v.prompt : v.negative))
    }
    if (Array.isArray(x)) return x.map(fill)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fill(y)]))
    return x
  }
  return fill(graph) as ComfyWorkflow['graph']
}

/** 工作流有没有问题：要有出图的节点、要用到 {{prompt}}，连线指向的节点要存在 */
export function checkWorkflow(graph: ComfyWorkflow['graph'], known?: Set<string>): string[] {
  const errors: string[] = []
  const ids = new Set(Object.keys(graph))
  if (!ids.size) return [t('工作流是空的')]
  const text = JSON.stringify(graph)
  if (!text.includes('{{prompt}}')) errors.push(t('没有用到 {{prompt}}：生成时的描述放不进去'))
  if (!Object.values(graph).some((n) => n.class_type === 'SaveImage' || n.class_type === 'PreviewImage'))
    errors.push(t('没有 SaveImage 节点：拿不到生成的图片'))
  for (const [id, n] of Object.entries(graph)) {
    if (known && !known.has(n.class_type))
      errors.push(t('节点 {id} 的类型 {type} 在 ComfyUI 里不存在', { id, type: n.class_type }))
    for (const [k, v] of Object.entries(n.inputs ?? {}))
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' && !ids.has(v[0]))
        errors.push(t('节点 {id} 的输入 {input} 连到了不存在的节点 {to}', { id, input: k, to: v[0] }))
  }
  return errors
}

/** 图片用途：自动模式按它选工作流 */
export function imageUse(
  img: { width: number; height: number; transparent: boolean; nineSlice?: unknown; name?: string; prompt?: string },
  kind: 'game' | 'web',
): WorkflowUse {
  if (img.nineSlice) return 'panel'
  const big = Math.max(img.width, img.height)
  if (/btn|button|按钮/i.test(`${img.name ?? ''} ${img.prompt ?? ''}`) && kind === 'game') return 'button'
  if (img.transparent && big <= 256) return 'icon'
  if (!img.transparent && big >= 800) return 'background'
  return kind === 'web' ? 'illustration' : img.transparent ? 'icon' : 'background'
}

/**
 * 选工作流：指定了就用它；自动时在这一类（游戏 / 网页）里找用途对得上、模型已经下载好的，
 * 找不到再用通用的、最后用任何一个能跑的
 */
export function pickWorkflow(
  list: ComfyWorkflow[],
  want: string,
  kind: 'game' | 'web',
  use: WorkflowUse,
  ready: (wf: ComfyWorkflow) => boolean,
): ComfyWorkflow | undefined {
  if (want && want !== 'auto') return list.find((w) => w.id === want)
  const mine = list.filter((w) => w.kind === kind && ready(w))
  return (
    mine.find((w) => w.use === use) ??
    (use === 'button' || use === 'panel' ? mine.find((w) => w.use === 'icon') : undefined) ??
    mine.find((w) => w.use === 'any') ??
    mine[0] ??
    list.find(ready)
  )
}

/**
 * 从 ComfyUI 导出的接口格式工作流自动加占位符：接到采样器 positive / negative 的文字节点换成 {{prompt}} / {{negative}}，
 * 空白画布的宽高和批量、采样器的种子换成对应的占位符。已经有占位符的不动
 */
export function autoPlaceholders(graph: ComfyWorkflow['graph']): ComfyWorkflow['graph'] {
  const g = structuredClone(graph)
  const text = JSON.stringify(g)
  const ref = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'string' ? g[v[0]] : undefined)
  // 顺着连线找到真正写文字的节点（中间可能隔着 ConditioningZeroOut 之类的节点）
  const textNode = (v: unknown, depth = 0): ComfyNode | undefined => {
    const n = ref(v)
    if (!n || depth > 4) return undefined
    if (typeof n.inputs.text === 'string') return n
    return textNode(n.inputs.conditioning ?? n.inputs.positive, depth + 1)
  }
  for (const n of Object.values(g)) {
    if (!text.includes('{{prompt}}')) {
      const pos = textNode(n.inputs.positive)
      if (pos) pos.inputs.text = '{{prompt}}'
    }
    if (!text.includes('{{negative}}')) {
      const neg = ref(n.inputs.negative)
      if (neg && typeof neg.inputs.text === 'string' && neg !== textNode(n.inputs.positive))
        neg.inputs.text = '{{negative}}'
    }
    if (/EmptyLatentImage|Empty.*LatentImage/.test(n.class_type)) {
      if (typeof n.inputs.width === 'number') n.inputs.width = '{{width}}'
      if (typeof n.inputs.height === 'number') n.inputs.height = '{{height}}'
      if (typeof n.inputs.batch_size === 'number') n.inputs.batch_size = '{{count}}'
    }
    if (/Scheduler/.test(n.class_type) && typeof n.inputs.width === 'number') {
      n.inputs.width = '{{width}}'
      n.inputs.height = '{{height}}'
    }
    if (typeof n.inputs.seed === 'number') n.inputs.seed = '{{seed}}'
    if (typeof n.inputs.noise_seed === 'number') n.inputs.noise_seed = '{{seed}}'
  }
  return g
}
