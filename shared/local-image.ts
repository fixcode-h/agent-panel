import { z } from 'zod'
import { t } from './i18n.ts'

/**
 * 本机生图：用 ComfyUI 跑开源图片模型。
 * 选 ComfyUI 是因为它有完整的 HTTP 接口（提交工作流、取结果），同一套接口能跑 Z-Image、FLUX、SDXL、Qwen-Image，
 * 新模型出来官方当天就支持；Fooocus、WebUI 这类偏手动操作，接口弱，也跟不上新模型。
 *
 * 模型文件和工作流参数都取自 ComfyUI 官方的工作流模板（Comfy-Org/workflow_templates），下载地址是 Hugging Face 上的官方重新打包版。
 */

/**
 * ComfyUI/models 下的目录。模板商店里的工作流还会用到 controlnet、clip_vision、upscale_models，
 * 这些不预置在模型清单里，按模板依赖按需下载
 */
export type LocalDir =
  | 'checkpoints'
  | 'diffusion_models'
  | 'text_encoders'
  | 'vae'
  | 'loras'
  | 'controlnet'
  | 'clip_vision'
  | 'upscale_models'
  | 'background_removal'

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
  {
    id: 'flux1-dev',
    dir: 'checkpoints',
    file: 'flux1-dev-fp8.safetensors',
    url: `${HF}/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors`,
    gb: 17.2,
  },
  {
    id: 'zimage-int8',
    dir: 'diffusion_models',
    file: 'z_image_turbo_int8_convrot.safetensors',
    url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors`,
    gb: 11.3,
  },
  // MOSS-Image 的文件名和大小取自 Comfy-Org/MOSS-Image 仓库的文件列表；
  // flux2-vae_small 和项目已有的 flux2-vae 不是同一个文件，都要下
  {
    id: 'moss-unet',
    dir: 'diffusion_models',
    file: 'moss_image_sft_int8_convrot.safetensors',
    url: `${HF}/Comfy-Org/MOSS-Image/resolve/main/diffusion_models/moss_image_sft_int8_convrot.safetensors`,
    gb: 5.4,
  },
  {
    id: 'moss-te',
    dir: 'text_encoders',
    file: 'qwen3.5_9b_w4a8_gptq.safetensors',
    url: `${HF}/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors`,
    gb: 7.3,
  },
  {
    id: 'moss-vae',
    dir: 'vae',
    file: 'flux2-vae_small.safetensors',
    url: `${HF}/Comfy-Org/MOSS-Image/resolve/main/vae/flux2-vae_small.safetensors`,
    gb: 0.25,
  },
  {
    id: 'moss-unet-bf16',
    dir: 'diffusion_models',
    file: 'moss_image_sft_bf16.safetensors',
    url: `${HF}/Comfy-Org/MOSS-Image/resolve/main/diffusion_models/moss_image_sft_bf16.safetensors`,
    gb: 10.2,
  },
  {
    id: 'moss-te-bf16',
    dir: 'text_encoders',
    file: 'qwen3.5_9b_bf16.safetensors',
    url: `${HF}/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_bf16.safetensors`,
    gb: 19.3,
  },
  // 去背景用的 BiRefNet 权重：ComfyUI 原生节点 LoadBackgroundRemovalModel 只认这个目录和这个文件名，
  // 大小取自官方模板 utility_birefnet_remove_background 的说明（423.9 MB）
  {
    id: 'birefnet',
    dir: 'background_removal',
    file: 'birefnet.safetensors',
    url: `${HF}/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors`,
    gb: 0.42,
  },
]

/**
 * 处理类模型：不吃提示词，处理一张输入图（去背景、放大）。和文本生图分开列，自动选工作流时也不会被选中
 */
export type LocalFamily = 'zimage' | 'flux2klein' | 'flux1' | 'flux1dev' | 'sdxl' | 'qwen' | 'moss' | 'birefnet'

/** 模型按用途分组展示；顺序就是设置页里从上到下的顺序 */
export const LOCAL_MODEL_GROUPS = [
  {
    id: 'text',
    title: t('文本生图'),
    desc: t('主力模型：按描述整张出图，图标、插画、背景和整屏原画都用得上'),
  },
  {
    id: 'fast',
    title: t('加速与量化'),
    desc: t('少步数或量化版本：出图更快、占显存更少，适合批量试稿和显存紧的电脑'),
  },
  {
    id: 'process',
    title: t('图片处理'),
    desc: t('不吃提示词，处理一张已有的图：去背景（透明底的 PNG）、放大'),
  },
  {
    id: 'light',
    title: t('低显存'),
    desc: t('8GB 显存左右也能跑；社区风格模型和 LoRA 最多'),
  },
] as const

export type LocalCategory = (typeof LOCAL_MODEL_GROUPS)[number]['id']

export interface LocalModel {
  id: string
  name: string
  family: LocalFamily
  /** 设置页里的分组 */
  category: LocalCategory
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
    category: 'text',
    files: ['zimage-unet', 'qwen3-4b', 'flux-ae'],
    vram: 16,
    use: t('主力推荐：图标、按钮、面板、插画、整屏原画都好用，8 步出图，听得懂中文描述'),
    license: 'Apache-2.0',
    base: 1024,
    recommended: true,
    natural: true,
  },
  {
    id: 'flux1-dev',
    name: 'FLUX.1 [dev]',
    family: 'flux1dev',
    category: 'text',
    files: ['flux1-dev'],
    vram: 16,
    use: t('质量优先：20 步出图，光影和材质更细腻，适合定风格的插画和原画；非商用许可'),
    license: 'FLUX.1 [dev] Non-Commercial',
    base: 1024,
    natural: true,
  },
  {
    id: 'qwen-image',
    name: 'Qwen-Image（Lightning 8 步）',
    family: 'qwen',
    category: 'text',
    files: ['qwen-unet', 'qwen-te', 'qwen-vae', 'qwen-lightning'],
    vram: 24,
    use: t('图里要有文字时用：标题、按钮上的中英文字写得准，也擅长海报式的整屏原画；体积大，要 24GB 显存'),
    license: 'Apache-2.0',
    base: 1328,
    natural: true,
  },
  {
    id: 'flux2-klein',
    name: 'FLUX.2 [klein] 4B',
    family: 'flux2klein',
    category: 'fast',
    files: ['klein-unet', 'qwen3-4b', 'flux2-vae'],
    vram: 12,
    use: t('显存 12GB 左右的首选：4 步出图最快，适合大批量的道具图标、草图和反复试风格'),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
  {
    id: 'z-image-turbo-int8',
    name: 'Z-Image Turbo Int8',
    family: 'zimage',
    category: 'fast',
    files: ['zimage-int8', 'qwen3-4b', 'flux-ae'],
    vram: 12,
    use: t('Z-Image Turbo 的量化版本：同样 8 步，文件更小、显存占用更低，适合显存 12GB 左右的电脑'),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
  {
    id: 'flux1-schnell',
    name: 'FLUX.1 [schnell]',
    family: 'flux1',
    category: 'fast',
    files: ['schnell'],
    vram: 12,
    use: t('老牌快速模型：4 步出图，质感好，适合背景图和插画；单个文件，下载最省事'),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
  {
    id: 'moss-image',
    name: 'MOSS-Image（布局 JSON）',
    family: 'moss',
    category: 'text',
    files: ['moss-unet', 'moss-te', 'moss-vae'],
    vram: 16,
    use: t(
      '图里要文字、要精确摆放时用：中英文都写得准，还能按布局 JSON 把标题、按钮文字放到指定位置；ComfyUI 要 0.42 以上',
    ),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
  {
    id: 'moss-image-bf16',
    name: 'MOSS-Image SFT（bf16）',
    family: 'moss',
    category: 'text',
    files: ['moss-unet-bf16', 'moss-te-bf16', 'moss-vae'],
    vram: 32,
    use: t('MOSS-Image 的 bf16 版本：文字和画质更稳，文件大一半多，32GB 以上显存时用'),
    license: 'Apache-2.0',
    base: 1024,
    natural: true,
  },
  {
    id: 'sdxl',
    name: 'SDXL 1.0',
    family: 'sdxl',
    category: 'light',
    files: ['sdxl'],
    vram: 8,
    use: t('8GB 显存也能跑；社区的风格模型和 LoRA 最多（像素风、卡通、二次元），可以换成自己下载的同类模型'),
    license: 'OpenRAIL++',
    base: 1024,
    natural: false,
  },
  {
    id: 'birefnet',
    name: 'BiRefNet',
    family: 'birefnet',
    category: 'process',
    files: ['birefnet'],
    vram: 4,
    use: t('按主体分割抠图，输出带透明通道的 PNG：图标去底、把生成的图叠到别的背景上时用'),
    license: 'MIT',
    /** 处理类模型不吃提示词和尺寸，base 不参与换算，写和文本模型一样的值避两套分支 */
    base: 1024,
    natural: true,
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

/**
 * 装 ComfyUI 的依赖时备用的 PyPI 索引：清华的同步会滞后几个小时，刚发布的子包
 * （例如 comfyui-workflow-templates-media-assets-02）在它那里是 404，只挂清华一个索引时整条 requirements 都装不上
 */
export const PYPI_FALLBACK = 'https://mirrors.aliyun.com/pypi/simple'

export type LocalGpu = 'cuda' | 'rocm' | 'mps' | 'cpu'

/**
 * 装 PyTorch 用的索引：官方源在国内只有 1~2 MB/s，2.7GB 的 torch wheel 下到一半断开，
 * 整个安装就失败（用户看到的是「已取消」）。上海交大的 PyTorch wheel 镜像同样是 2.7GB，
 * 两分多钟下完，而且和官方一样是 PEP 503 索引，torch / torchvision / torchaudio 连依赖一起有。
 * CUDA 用 cu130：ComfyUI 0.42 起要求 cu130+，更低版本会禁掉 comfy-kitchen 的 CUDA 加速后端
 */
export const TORCH_INDEX: Record<LocalGpu, { official: string; mirror?: string }> = {
  cuda: {
    official: 'https://download.pytorch.org/whl/cu130',
    mirror: 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu130',
  },
  rocm: {
    official: 'https://download.pytorch.org/whl/rocm6.4',
    mirror: 'https://mirror.sjtu.edu.cn/pytorch-wheels/rocm6.4',
  },
  cpu: { official: 'https://download.pytorch.org/whl/cpu', mirror: 'https://mirror.sjtu.edu.cn/pytorch-wheels/cpu' },
  // 苹果芯片用 PyPI 上的默认包，没有单独的索引
  mps: { official: '' },
}

/** 装 PyTorch 依次尝试的索引：开了国内镜像先用镜像、装不上再回退官方；苹果和没开镜像时只给一条 */
export function torchIndexes(gpu: LocalGpu, mirror: boolean): string[] {
  const i = TORCH_INDEX[gpu]
  if (!i.official) return ['']
  return mirror && i.mirror ? [i.mirror, i.official] : [i.official]
}

/**
 * 「让 AI 安装」的第一句话：不是报错，是让它在这台电脑上直接把环境装好。
 * 具体环境（显卡、Python、安装目录、装完怎么验证）由 server/comfy.ts 的 local-image topic 补上
 */
export const INSTALL_ASK =
  '在这台电脑上把本机生图用的 ComfyUI 直接装好（面板的「一键安装」还没成功）。按下面给的环境选对 PyTorch 的版本，网络慢时用国内镜像，把依赖装全、验证能导入，再按约定写入安装完成标记。'

/** 安装、下载、修复的进度（同一时间只有一个） */
export interface LocalJob {
  id: string
  kind: 'install' | 'download' | 'start'
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

/**
 * 本机生图对 Python 的版本要求：检测、安装、报错文案和界面都从这里取，不要在别处另写一份范围。
 * - ComfyUI 的 pyproject.toml 要求 >=3.10；README 说 3.13 支持得最好，3.14 能用但个别自定义节点可能有问题
 * - PyTorch 2.9 起给 3.14 出了 wheel（cp314），2.8 及以前只到 cp313，所以 3.14 能用
 * - torchvision 的 requires-python 是 `!=3.14.1,>=3.10`：恰好 3.14.1 装不上，列进 blocked 单独提示
 */
export const PYTHON_SUPPORT = {
  min: '3.10',
  max: '3.14',
  /** 没装 Python 时提示装哪个：ComfyUI 说支持得最好的版本 */
  recommend: '3.13',
  /** 有 PyTorch 的 wheel、但 ComfyUI 的某个依赖还没发这个版本的包的具体版本 */
  blocked: ['3.14.1'],
}

/** 支持的版本范围，拼进文案用：`3.10 ~ 3.14` */
export const PYTHON_RANGE = `${PYTHON_SUPPORT.min} ~ ${PYTHON_SUPPORT.max}`

/** 从 min 到 max 的次版本号，从高到低：找 Python 时按这个顺序试，安装就用找到的最高版本 */
export const PYTHON_VERSIONS: string[] = (() => {
  const [major, minMinor] = PYTHON_SUPPORT.min.split('.').map(Number)
  const maxMinor = Number(PYTHON_SUPPORT.max.split('.')[1])
  return Array.from({ length: maxMinor - minMinor + 1 }, (_, i) => `${major}.${maxMinor - i}`)
})()

export type PythonIssue = 'too-old' | 'too-new' | 'blocked'

/** 只按版本判断能不能用来装 ComfyUI，不管装没装：范围外、或依赖还没发对应包的版本都不行 */
export function pythonSupport(version: string): { ok: true } | { ok: false; issue: PythonIssue } {
  const v = version.trim()
  const [major, minor] = v.split('.').map(Number)
  const num = (x: string) => {
    const [a, b] = x.split('.').map(Number)
    return a * 1000 + b
  }
  if (!major || num(v) < num(PYTHON_SUPPORT.min)) return { ok: false, issue: 'too-old' }
  if (!minor || num(v) > num(PYTHON_SUPPORT.max)) return { ok: false, issue: 'too-new' }
  if (PYTHON_SUPPORT.blocked.includes(v)) return { ok: false, issue: 'blocked' }
  return { ok: true }
}

/** 版本不支持的说明：告诉用户为什么不行、该装哪个 */
export function pythonIssueText(version: string, issue: PythonIssue): string {
  if (issue === 'too-old') return t('Python {v} 太旧了：本机生图要 {range}', { v: version, range: PYTHON_RANGE })
  if (issue === 'too-new')
    return t('Python {v} 太新了：PyTorch 还没有这个版本的安装包，目前支持到 {range}', {
      v: version,
      range: PYTHON_RANGE,
    })
  return t('Python {v} 装不上：ComfyUI 的依赖还没有这个版本的安装包，请改用 {recommend}', {
    v: version,
    recommend: PYTHON_SUPPORT.recommend,
  })
}

/** 探测 Python 的输出：第一行是版本（sys.version_info），第二行是解释器路径（sys.executable） */
export function parsePythonProbe(stdout: string): { version?: string; path?: string } {
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
  const version = /^\d+\.\d+(\.\d+)?$/.test(lines[0] ?? '') ? lines[0] : undefined
  return { version, path: lines[1] || undefined }
}

/** 探测到的一个 Python：调用命令、解释器路径、版本，以及能不能用来装 ComfyUI */
export interface LocalPython {
  /** 调用的命令，例如 `py -3.14`、`/usr/bin/python3.12` */
  command: string
  /** 解释器的真实路径（sys.executable） */
  path?: string
  version: string
  usable: boolean
  /** 不能用的原因（usable 为 false 时） */
  problem?: string
}

export interface LocalStatus {
  /** 安装目录：软件目录下的 comfyui/ */
  dir: string
  installed: boolean
  running: boolean
  /** 用已有的 ComfyUI（设置里填了地址）时不管安装和启动 */
  external: boolean
  url: string
  /** 检测到的 Python：能用的按版本从高到低排在前面，用不了的带原因 */
  pythons: LocalPython[]
  /** 已经装好的虚拟环境里的解释器：启动 ComfyUI、装依赖用的就是它 */
  venv?: LocalPython
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

const P = {
  prompt: '{{prompt}}',
  negative: '{{negative}}',
  width: '{{width}}',
  height: '{{height}}',
  count: '{{count}}',
  seed: '{{seed}}',
}

/**
 * 需要输入图的占位符：处理类工作流（去背景、图生图、放大）的入口。
 * 链里被上游的输出替掉，链的第一段由外部上传的原图填。
 */
export const IMAGE_PLACEHOLDER = '{{image}}'

/** 图生图的去噪强度：0.6 大概是「保留原图的构图和配色，换掉细节和风格」 */
export const IMG2IMG_DENOISE = 0.6

/** 插值放大的倍数：不做细节修复，只是把图放大好当底图用 */
export const UPSCALE_FACTOR = 2

/**
 * 生成 ComfyUI 的接口格式工作流（节点 id → 节点）。参数照官方模板：
 * Z-Image 8 步 res_multistep、FLUX.2 klein 4 步、Qwen-Image 加 Lightning LoRA 8 步、FLUX.1 schnell 4 步、SDXL 25 步、
 * MOSS-Image 25 步 er_sde（加官方模板的跳过层引导）
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
    /** 正向提示词换成 {{layout}}：生成时传布局 JSON，没有布局时回退成描述 */
    layout?: boolean
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
    case 'flux1dev':
      return {
        ckpt: n('CheckpointLoaderSimple', { ckpt_name: f('flux1-dev') }),
        pos: n('CLIPTextEncode', { text: o.prompt, clip: ['ckpt', 1] }),
        neg: n('CLIPTextEncode', { text: o.negative, clip: ['ckpt', 1] }),
        // dev 是蒸馏 guidance 的模型：cfg 保持 1，提示词强度由 FluxGuidance 控制
        guide: n('FluxGuidance', { conditioning: ['pos', 0], guidance: 3.5 }),
        latent: n('EmptySD3LatentImage', latent),
        sample: n('KSampler', {
          model: ['ckpt', 0],
          seed: o.seed,
          steps: o.steps ?? 20,
          cfg: 1,
          sampler_name: 'euler',
          scheduler: 'simple',
          positive: ['guide', 0],
          negative: ['neg', 0],
          latent_image: ['latent', 0],
          denoise: 1,
        }),
        decode: n('VAEDecode', { samples: ['sample', 0], vae: ['ckpt', 2] }),
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
    case 'moss': {
      // int8 和 bf16 用同一个节点图，文件按模型实际带的那几个取
      const byDir = (dir: LocalDir) => m.files.map(localFile).find((x) => x?.dir === dir)?.file ?? ''
      return {
        unet: n('UNETLoader', { unet_name: byDir('diffusion_models'), weight_dtype: 'default' }),
        clip: n('CLIPLoader', { clip_name: byDir('text_encoders'), type: 'moss_image', device: 'default' }),
        vae: n('VAELoader', { vae_name: byDir('vae') }),
        // 官方模板的跳过层引导：跳过第 22 层，前一半步数生效，细节不容易糊
        slg: n('SkipLayerGuidanceDiTSimple', {
          model: ['unet', 0],
          double_layers: '',
          single_layers: '22',
          start_percent: 0,
          end_percent: 0.5,
        }),
        pos: n('CLIPTextEncode', { text: o.layout ? '{{layout}}' : o.prompt, clip: ['clip', 0] }),
        neg: n('CLIPTextEncode', { text: o.negative, clip: ['clip', 0] }),
        latent: n('EmptyFlux2LatentImage', latent),
        // 25 步、CFG 2.5、er_sde 是官方模板的快速参数；要更接近官方效果可以调到 50 步、CFG 3
        sample: ksampler(['slg', 0], o.steps ?? 25, 2.5, 'er_sde', 'simple'),
        decode: n('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] }),
        save: save(['decode', 0]),
      }
    }
    // 处理类模型不吃提示词和尺寸，走 removeBgGraph / upscaleGraph，不在这里生成文生图
    case 'birefnet':
      throw new Error(t('{name} 是图片处理模型，不能用来文生图', { name: m.name }))
  }
}

/**
 * 去背景工作流（透明底 PNG）：节点取自本机 ComfyUI 0.42 的 /object_info，接法照官方模板
 * utility_birefnet_remove_background（子图内部：RemoveBackground → InvertMask → JoinImageWithAlpha 的 alpha）
 */
export const removeBgGraph = (): ComfyWorkflow['graph'] => {
  const n = (class_type: string, inputs: Record<string, unknown>): Node => ({ class_type, inputs })
  return {
    image: n('LoadImage', { image: IMAGE_PLACEHOLDER }),
    // RemoveBackground 出的是前景 mask；JoinImageWithAlpha 内部按 1-mask 算 alpha，
    // 所以要先 InvertMask，不然抠出来的是背景（官方模板就是这么接的）
    model: n('LoadBackgroundRemovalModel', { bg_removal_name: localFile('birefnet')!.file }),
    remove: n('RemoveBackground', { bg_removal_model: ['model', 0], image: ['image', 0] }),
    invert: n('InvertMask', { mask: ['remove', 0] }),
    alpha: n('JoinImageWithAlpha', { image: ['image', 0], alpha: ['invert', 0] }),
    save: n('SaveImage', { images: ['alpha', 0], filename_prefix: 'agent-panel' }),
  }
}

/** 插值放大：只是把图变大，不做细节修复（模型放大要 upscale_models 里的权重，不在预置清单里） */
export const upscaleGraph = (): ComfyWorkflow['graph'] => {
  const n = (class_type: string, inputs: Record<string, unknown>): Node => ({ class_type, inputs })
  return {
    image: n('LoadImage', { image: IMAGE_PLACEHOLDER }),
    scale: n('ImageScaleBy', { image: ['image', 0], upscale_method: 'lanczos', scale_by: UPSCALE_FACTOR }),
    save: n('SaveImage', { images: ['scale', 0], filename_prefix: 'agent-panel' }),
  }
}

const vaeRef = (g: ComfyWorkflow['graph']): [string, number] | undefined => {
  // 内置工作流的 VAE：单独加载的取 VAELoader，SDXL / FLUX.1 从 CheckpointLoaderSimple 的第三个输出取
  const vaeNode = Object.entries(g).find(([, n]) => n.class_type === 'VAELoader')
  const ckptNode = Object.entries(g).find(([, n]) => n.class_type === 'CheckpointLoaderSimple')
  return vaeNode ? [vaeNode[0], 0] : ckptNode ? [ckptNode[0], 2] : undefined
}

/**
 * 图生图：把工作流改成从原图出发——原图 VAE 编码成 latent，采样器降 denoise 只改一部分，构图和配色保留。
 * 两种采样器分开接：KSampler 直接设 denoise；SamplerCustomAdvanced 没有 denoise，用 SplitSigmasDenoise 只走后半段。
 * 都不匹配时返回 undefined，调用方报「这一段不能接图」，不硬编
 */
export function imageToImage(
  graph: ComfyWorkflow['graph'],
  o: { image: string; denoise?: number },
): ComfyWorkflow['graph'] | undefined {
  const g = structuredClone(graph)
  const vae = vaeRef(g)
  const denoise = o.denoise ?? IMG2IMG_DENOISE
  const ksampler = Object.values(g).find((n) => n.class_type === 'KSampler')
  const custom = Object.values(g).find((n) => n.class_type === 'SamplerCustomAdvanced')
  if (!vae || (!ksampler && !custom)) return undefined
  g[IMAGE_INPUT_NODE] = { class_type: 'LoadImage', inputs: { image: o.image } }
  g[IMAGE_INPUT_LATENT] = { class_type: 'VAEEncode', inputs: { pixels: [IMAGE_INPUT_NODE, 0], vae } }
  const latent: [string, number] = [IMAGE_INPUT_LATENT, 0]
  if (ksampler) {
    ksampler.inputs.latent_image = latent
    ksampler.inputs.denoise = denoise
  } else if (custom) {
    const sigmas = custom.inputs.sigmas
    const split = `${IMAGE_INPUT_LATENT}_split`
    g[split] = { class_type: 'SplitSigmasDenoise', inputs: { sigmas, denoise } }
    custom.inputs.sigmas = [split, 1]
    custom.inputs.latent_image = latent
  }
  return g
}

/** 工作流里代表「输入图」的两个节点 id：链合并节点图时靠它们认锚点和接线 */
export const IMAGE_INPUT_NODE = 'in_image'
export const IMAGE_INPUT_LATENT = 'in_latent'

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
  /** both：处理类工作流（去背景、放大）不分游戏和网页，两边都列出来 */
  kind: z.enum(['game', 'web', 'both']),
  use: z.enum(WORKFLOW_USES).default('any'),
  description: z.string().max(2000).default(''),
  /** 用到的内置模型（LOCAL_MODELS 的 id），用来检查下载了没有；自己的模型留空 */
  model: z.string().default(''),
  /** 模板带进来的依赖文件（ComfyUI/models 下的相对路径），用来判断缺不缺文件；自己的模型留空 */
  assets: z.array(z.string()).default([]),
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

/** 工作流在游戏 / 网页这一栏里出不出来：处理类工作流两边都要能用 */
export const workflowInKind = (w: Pick<ComfyWorkflow, 'kind'>, kind: 'game' | 'web') =>
  w.kind === kind || w.kind === 'both'

/** 工作流里有没有输入图锚点（{{image}}）：有的话它不参与自动挑选，选前得先给它一张图 */
export const needsInputImage = (graph: ComfyWorkflow['graph']) => JSON.stringify(graph).includes(IMAGE_PLACEHOLDER)
const builtin = (
  id: string,
  kind: ComfyWorkflow['kind'],
  use: WorkflowUse,
  model: string,
  name: string,
  description: string,
  extra: string,
  steps?: number,
  /** 正向提示词用 {{layout}}：生成时传布局 JSON，没有布局时回退成描述 */
  layout?: boolean,
): ComfyWorkflow => ({
  id,
  name,
  kind,
  use,
  model,
  assets: [],
  description,
  extra,
  graph: localWorkflow(localModel(model)!, { ...P, steps, layout }),
  builtin: true,
  updatedAt: '',
})

/** 处理类内置工作流：不吃提示词和尺寸，只需一张输入图 */
const processingBuiltin = (o: {
  id: string
  name: string
  description: string
  model: string
  graph: ComfyWorkflow['graph']
}): ComfyWorkflow => ({
  id: o.id,
  name: o.name,
  // 游戏和网页都用得上：两个分类里都列出来
  kind: 'both',
  use: 'any',
  model: o.model,
  // 依赖的文件按模型清单推导，不另写一份：缺文件时工作流页会直接标出来
  assets: modelAssets(o.model),
  description: o.description,
  extra: '',
  graph: o.graph,
  builtin: true,
  updatedAt: '',
})

/** 模型要的文件在 ComfyUI/models 下的相对路径（“目录/文件”），和模板商店的 assets 写法一致 */
const modelAssets = (id: string): string[] =>
  (localModel(id)?.files ?? []).flatMap((f) => {
    const file = localFile(f)
    return file ? [`${file.dir}/${file.file}`] : []
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
    'game-moss-layout',
    'game',
    'concept',
    'moss-image',
    t('MOSS-Image：按 JSON 布局出图'),
    t('整屏原画里要出现准确的中英文、还要按设计稿位置摆放时用：标题、按钮文字和主要元素的位置由布局 JSON 指定'),
    'Precise UI layout: every text block and UI element appears exactly at its specified position, correct reading order, clean hierarchy.',
    25,
    true,
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
  // 处理类：不吃提示词，只要一张输入的图；链里当中间段时输入由上游接上
  processingBuiltin({
    id: 'game-remove-bg',
    name: t('去背景（透明底 PNG）'),
    description: t(
      '把图的主体抠出来，输出带透明通道的 PNG：图标去底、把生成的图叠到别的背景上时用；链的开头也可以先接它',
    ),
    model: 'birefnet',
    graph: removeBgGraph(),
  }),
  processingBuiltin({
    id: 'game-img2img',
    name: t('图生图 · 风格复刻'),
    description: t(
      '在已有图的基础上重画：保留构图、布局和大体配色，按描述换掉细节和风格（去噪 {n}）；改配色、换画风、把草图做成正式稿时用',
      { n: IMG2IMG_DENOISE },
    ),
    model: 'z-image-turbo',
    // 先拿到文生图的节点图，再改成从原图出发：参数只有一套，不另写一份
    graph: imageToImage(localWorkflow(localModel('z-image-turbo')!, { ...P }), { image: IMAGE_PLACEHOLDER })!,
  }),
  processingBuiltin({
    id: 'game-upscale',
    name: t('放大 {n} 倍', { n: UPSCALE_FACTOR }),
    description: t('插值放大 {n} 倍，尺寸变大但细节不增强：出完的图当底图、叠到高分辨率界面里时用', {
      n: UPSCALE_FACTOR,
    }),
    model: '',
    graph: upscaleGraph(),
  }),
]

/** 用到的占位符都换成实际的值 */
export function fillWorkflow(
  graph: ComfyWorkflow['graph'],
  v: {
    prompt: string
    negative: string
    width: number
    height: number
    count: number
    seed: number
    /** 布局 JSON（MOSS-Image）；没有时 {{layout}} 回退成描述，工作流照常能跑 */
    layout?: string
    /** 输入图的文件名（处理类工作流、图生图）；不传时 {{image}} 保持原样，由调用方（链）接力 */
    image?: string
  },
) {
  const nums: Record<string, number> = { width: v.width, height: v.height, count: v.count, seed: v.seed }
  const fill = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const whole = /^\{\{(\w+)\}\}$/.exec(x)
      if (whole && whole[1] in nums) return nums[whole[1]]
      return x.replace(/\{\{(prompt|negative|layout|image)\}\}/g, (m, k: string) =>
        k === 'prompt'
          ? v.prompt
          : k === 'negative'
            ? v.negative
            : k === 'layout'
              ? v.layout || v.prompt
              : (v.image ?? m),
      )
    }
    if (Array.isArray(x)) return x.map(fill)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fill(y)]))
    return x
  }
  return fill(graph) as ComfyWorkflow['graph']
}

/**
 * 把内置工作流改成局部重绘：原图和蒙版图先上传到 ComfyUI，用 LoadImage 读进来，
 * VAEEncode 编码原图，再用 SetLatentNoiseMask 把蒙版之外锁住，采样器只重画蒙版区域。
 * 找不到采样器或者 VAE 的工作流（用户自己导入的）返回 undefined，调用方降级成整张重画
 */
export function inpaintWorkflow(
  graph: ComfyWorkflow['graph'],
  o: { image: string; mask: string },
): ComfyWorkflow['graph'] | undefined {
  const g = structuredClone(graph)
  const sampler = Object.values(g).find((n) => n.class_type === 'KSampler' || n.class_type === 'SamplerCustomAdvanced')
  if (!sampler) return undefined
  const vae = vaeRef(g)
  if (!vae) return undefined
  g['ip_image'] = { class_type: 'LoadImage', inputs: { image: o.image } }
  g['ip_mask'] = { class_type: 'LoadImage', inputs: { image: o.mask } }
  g['ip_encode'] = { class_type: 'VAEEncode', inputs: { pixels: ['ip_image', 0], vae } }
  g['ip_masknode'] = { class_type: 'ImageToMask', inputs: { image: ['ip_mask', 0], channel: 'red' } }
  g['ip_set'] = {
    class_type: 'SetLatentNoiseMask',
    inputs: { samples: ['ip_encode', 0], mask: ['ip_masknode', 0] },
  }
  sampler.inputs.latent_image = ['ip_set', 0]
  return g
}

/** ComfyUI 队列里的一项，面板展示用（节点图也带上，可以在面板里展开看） */
export interface ComfyQueueEntry {
  /** ComfyUI 的 prompt_id */
  id: string
  /** 队列里的序号 */
  number: number
  status: 'running' | 'pending'
  /** 面板提交时写的来源：AI 设计生成，或用户在 ComfyUI 网页里跑的（没有来源信息） */
  source?: 'design' | 'panel'
  workflowId?: string
  workflowName?: string
  /** 图片用途（图标、背景…），面板提交时带上 */
  use?: string
  /** 执行进度，由服务端从 ComfyUI 的 WebSocket 事件里收集 */
  progress?: { value: number; max: number; node?: string }
  /** 接口格式的节点图 */
  prompt: ComfyWorkflow['graph']
}

/** ComfyUI 现在在跑什么、还排着什么 */
export interface ComfyQueueState {
  up: boolean
  url: string
  running: ComfyQueueEntry[]
  pending: ComfyQueueEntry[]
}

const asRecord = (x: unknown): Record<string, unknown> | undefined =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined

/**
 * ComfyUI 的 /queue 有两代格式：旧版 { queue_running, queue_pending }，每一项是
 * [序号, prompt_id, 节点图, extra_data] 的数组；新版 { Running, Pending }，每一项是对象。
 * 两种都认，避免 ComfyUI 升级后面板读不到队列
 */
export function comfyQueueLists(raw: unknown): { running: unknown[]; pending: unknown[] } {
  const r = asRecord(raw) ?? {}
  const list = (x: unknown) => (Array.isArray(x) ? x : [])
  return { running: list(r.Running ?? r.queue_running), pending: list(r.Pending ?? r.queue_pending) }
}

/** 队列项里出图节点的文件名前缀（面板提交时写的是 agent-panel/工作流名） */
export function comfySavePrefix(graph: ComfyWorkflow['graph']): string | undefined {
  for (const n of Object.values(graph))
    if (n?.class_type === 'SaveImage' && typeof n.inputs?.filename_prefix === 'string') return n.inputs.filename_prefix
  return undefined
}

/** 把队列项（新旧两种）解成面板要的字段；节点图拿不到时返回 undefined */
export function comfyQueueEntry(raw: unknown, status: 'running' | 'pending'): ComfyQueueEntry | undefined {
  let id = ''
  let number = 0
  let prompt: unknown
  let extra: unknown
  if (Array.isArray(raw)) {
    number = Number(raw[0]) || 0
    id = String(raw[1] ?? '')
    prompt = raw[2]
    extra = raw[3]
  } else {
    const o = asRecord(raw)
    if (!o) return undefined
    id = String(o.prompt_id ?? '')
    number = Number(o.number) || 0
    prompt = o.prompt
    extra = o.extra_data
  }
  const graph = asRecord(prompt) as ComfyWorkflow['graph'] | undefined
  if (!id || !graph) return undefined
  const meta = asRecord(asRecord(extra)?.agent_panel)
  const prefix = comfySavePrefix(graph)
  // 名称优先用提交时的来源信息；别的途径跑的任务从文件名前缀里认
  const name = String(meta?.name ?? '').trim() || (prefix ? prefix.replace(/^agent-panel\//, '') : '')
  return {
    id,
    number,
    status,
    source: meta?.source === 'design' ? 'design' : meta ? 'panel' : undefined,
    workflowId: meta?.workflowId ? String(meta.workflowId) : undefined,
    workflowName: name || undefined,
    use: meta?.use ? String(meta.use) : undefined,
    prompt: graph,
  }
}

/** SaveImage 的输出前缀：agent-panel/工作流名，队列、历史和输出文件名里都能认出来 */
export function comfyFilenamePrefix(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return `agent-panel/${safe || 'workflow'}`
}

/** 提交前把 SaveImage 的文件名前缀换成可辨识的工作流名（不改原图，返回新的） */
export function markSavePrefix(graph: ComfyWorkflow['graph'], name: string): ComfyWorkflow['graph'] {
  const prefix = comfyFilenamePrefix(name)
  return Object.fromEntries(
    Object.entries(graph).map(([id, n]) => [
      id,
      n.class_type === 'SaveImage' ? { ...n, inputs: { ...n.inputs, filename_prefix: prefix } } : n,
    ]),
  )
}

/**
 * 面板里存的是带占位符的接口格式工作流，ComfyUI 的输入框不认 {{width}} 这类字符串：
 * 导入成 ComfyUI 工作流时换成能直接跑的示例值
 */
export function importableWorkflow(wf: ComfyWorkflow): ComfyWorkflow['graph'] {
  return markSavePrefix(
    fillWorkflow(wf.graph, {
      prompt: wf.description || wf.name,
      negative: '',
      width: 1024,
      height: 1024,
      count: 1,
      seed: Math.floor(Math.random() * 2 ** 31),
      // 导入到 ComfyUI 里要能直接跑：输入图先填个占位文件，用户在那里换成自己的图
      image: IMPORT_SAMPLE_IMAGE,
    }),
    wf.name,
  )
}

/** 工作流导入到 ComfyUI 时，输入图先填这个占位文件名（用户在那里换成自己的图） */
export const IMPORT_SAMPLE_IMAGE = 'example.png'

/** 导入到 ComfyUI 的 userdata/workflows 下的文件名：名字放前面方便在侧栏认，id 保证重复导入覆盖同一个文件 */
export function comfyImportFile(wf: Pick<ComfyWorkflow, 'id' | 'name'>): string {
  const safe = wf.name
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  const id = wf.id.replace(/[^\w-]/g, '').slice(0, 40)
  return `${safe || 'workflow'}-${id || 'x'}.json`
}

/**
 * 工作流有没有问题：要有出图的节点、要用到 {{prompt}}（或 {{layout}}），连线指向的节点要存在。
 * 处理类工作流（去背景、放大）只吃 {{image}}，不用提示词，那一条对它不适用
 */
export function checkWorkflow(graph: ComfyWorkflow['graph'], known?: Set<string>): string[] {
  const errors: string[] = []
  const ids = new Set(Object.keys(graph))
  if (!ids.size) return [t('工作流是空的')]
  const text = JSON.stringify(graph)
  // 用布局 JSON 的工作流可以不写 {{prompt}}：没有布局时它也会回退成描述；处理类工作流不嗂提示词
  if (!text.includes('{{prompt}}') && !text.includes('{{layout}}') && !text.includes(IMAGE_PLACEHOLDER))
    errors.push(t('没有用到 {{prompt}}：生成时的描述放不进去'))
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
 * 找不到再用通用的、最后用任何一个能跑的。
 * 需要输入图的工作流（去背景、图生图、放大）不参与自动挑选：自动流程手里没有原图，选了也只能失败
 */
export function pickWorkflow(
  list: ComfyWorkflow[],
  want: string,
  kind: 'game' | 'web',
  use: WorkflowUse,
  ready: (wf: ComfyWorkflow) => boolean,
  /** 同一用途里优先选的（例如有布局时优先能接 {{layout}} 的工作流） */
  prefer?: (wf: ComfyWorkflow) => boolean,
): ComfyWorkflow | undefined {
  if (want && want !== 'auto') return list.find((w) => w.id === want)
  const usable = (w: ComfyWorkflow) => !needsInputImage(w.graph)
  const mine = list.filter((w) => workflowInKind(w, kind) && ready(w) && usable(w))
  return (
    (prefer ? mine.find((w) => w.use === use && prefer(w)) : undefined) ??
    mine.find((w) => w.use === use) ??
    (use === 'button' || use === 'panel' ? mine.find((w) => w.use === 'icon') : undefined) ??
    mine.find((w) => w.use === 'any') ??
    mine[0] ??
    list.find((w) => ready(w) && usable(w))
  )
}

/**
 * 从 ComfyUI 导出的接口格式工作流自动加占位符：接到采样器 positive / negative 的文字节点换成 {{prompt}} / {{negative}}，
 * 空白画布的宽高和批量、采样器的种子换成对应的占位符。已经有 {{prompt}} / {{negative}} / {{layout}} 的不动
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
    // 布局工作流的正向节点是 {{layout}}，不能再改成 {{prompt}}，否则导入后布局静默失效
    if (!text.includes('{{prompt}}') && !text.includes('{{layout}}')) {
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
