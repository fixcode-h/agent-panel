import { t } from './i18n.ts'

/**
 * 本机语音输入：用 sherpa-onnx 在本机把录音转成文字，不联网识别。
 *
 * 默认什么都不下载：设置 →「语音输入」里打开开关、自己挑一个模型下载后，输入框上才出现麦克风按钮。
 * 识别库 sherpa-onnx-node 是原生扩展，不能打进单文件的 server.mjs，所以和模型一样按需下载到数据目录
 * （npm 包的 tgz，跟着第一次下载模型一起下），服务端用 createRequire 从那里加载，见 server/speech.ts。
 */

/** 识别库的版本：固定版本，下载地址和加载目录都按它拼，升级时改这里 */
export const SHERPA_VERSION = '1.13.8'

/** 识别库给这些平台发了预编译包（包名 sherpa-onnx-<平台>-<架构>，Windows 写 win） */
const SHERPA_PLATFORMS = ['win-x64', 'win-ia32', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']

/** 这台电脑对应的识别库包名；没有预编译包的平台返回空串 */
export function sherpaPlatformPackage(platform: string, arch: string) {
  const key = `${platform === 'win32' ? 'win' : platform}-${arch}`
  return SHERPA_PLATFORMS.includes(key) ? `sherpa-onnx-${key}` : ''
}

/** npm 包的 tgz 地址；镜像用 npmmirror（国内打不开 registry.npmjs.org 时） */
export function npmTarball(name: string, version: string, mirror: boolean) {
  const base = mirror ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org'
  return `${base}/${name}/-/${name}-${version}.tgz`
}

export type SpeechModelKind = 'sense-voice' | 'paraformer' | 'whisper'

export interface SpeechModel {
  id: string
  name: string
  /** 适合什么场景 */
  use: string
  kind: SpeechModelKind
  /** Hugging Face 上的仓库（sherpa-onnx 作者转好的 onnx） */
  repo: string
  /** 要下载的文件和大约大小（MB，只用来显示和估算进度） */
  files: { name: string; mb: number }[]
  recommended?: boolean
  /** 擅长的语言（显示用） */
  langs: string
  license: string
}

/**
 * 可以选的模型。文件名对着 sherpa-onnx 的发布包核对过（k2-fsa/sherpa-onnx 的 asr-models 发布）；
 * 加新模型时先确认 Hugging Face 仓库里真有这些文件，下载失败会把 404 原样报给用户
 */
export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: 'sense-voice-int8',
    name: 'SenseVoice Small（int8）',
    use: t(
      '中文、粤语、英文、日文、韩文都能识别，中英混说也认得准，自带标点。速度很快，普通 CPU 上几秒的话不到半秒出字',
    ),
    kind: 'sense-voice',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: [
      { name: 'model.int8.onnx', mb: 228 },
      { name: 'tokens.txt', mb: 0.3 },
    ],
    recommended: true,
    langs: '中 / 粤 / 英 / 日 / 韩',
    license: 'FunASR Model License',
  },
  {
    id: 'sense-voice',
    name: 'SenseVoice Small（完整精度）',
    use: t('和上面是同一个模型的完整精度版：准确率略高一点，体积是它的 4 倍左右、也慢一些'),
    kind: 'sense-voice',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: [
      { name: 'model.onnx', mb: 894 },
      { name: 'tokens.txt', mb: 0.3 },
    ],
    langs: '中 / 粤 / 英 / 日 / 韩',
    license: 'FunASR Model License',
  },
  {
    id: 'paraformer-zh-small-int8',
    name: 'Paraformer 中文 Small（int8）',
    use: t('阿里 FunASR 的中文小模型：只有 79MB，最省内存，普通话识别稳，也认得夹在中文里的英文单词；不带标点'),
    kind: 'paraformer',
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09',
    files: [
      { name: 'model.int8.onnx', mb: 79 },
      { name: 'tokens.txt', mb: 0.1 },
    ],
    langs: '中 / 英',
    license: 'FunASR Model License',
  },
  {
    id: 'whisper-small-int8',
    name: 'Whisper Small（int8）',
    use: t('OpenAI Whisper 的小号模型：支持近百种语言，英文为主时选它；中文偶尔会写成繁体'),
    kind: 'whisper',
    repo: 'csukuangfj/sherpa-onnx-whisper-small',
    files: [
      { name: 'small-encoder.int8.onnx', mb: 107 },
      { name: 'small-decoder.int8.onnx', mb: 250 },
      { name: 'small-tokens.txt', mb: 0.8 },
    ],
    langs: '多语言',
    license: 'MIT',
  },
  {
    id: 'whisper-turbo-int8',
    name: 'Whisper Large v3 Turbo（int8）',
    use: t('Whisper 里准确率最高的一档之一，多语言效果好；体积大，没有显卡时一句话要几秒'),
    kind: 'whisper',
    repo: 'csukuangfj/sherpa-onnx-whisper-turbo',
    files: [
      { name: 'turbo-encoder.int8.onnx', mb: 643 },
      { name: 'turbo-decoder.int8.onnx', mb: 344 },
      { name: 'turbo-tokens.txt', mb: 0.8 },
    ],
    langs: '多语言',
    license: 'MIT',
  },
]

export const DEFAULT_SPEECH_MODEL = SPEECH_MODELS[0].id
export const SPEECH_MODEL_IDS = SPEECH_MODELS.map((m) => m.id) as [string, ...string[]]

export const speechModel = (id: string) => SPEECH_MODELS.find((m) => m.id === id)

/** 模型文件的下载地址；镜像换成 hf-mirror.com，路径不变 */
export function speechFileUrl(m: SpeechModel, file: string, mirror: boolean) {
  const host = mirror ? 'https://hf-mirror.com' : 'https://huggingface.co'
  return `${host}/${m.repo}/resolve/main/${file}`
}

/** 一个模型的下载量（MB） */
export const speechModelMb = (m: SpeechModel) => m.files.reduce((n, f) => n + f.mb, 0)

/**
 * 交给 sherpa-onnx OfflineRecognizer 的配置。file 把文件名换成模型目录里的完整路径，
 * 放在 shared 里是为了不加载原生库也能测
 */
export function recognizerConfig(m: SpeechModel, file: (name: string) => string, threads: number) {
  const pick = (part: string) => file(m.files.find((f) => f.name.includes(part))!.name)
  const tokens = pick('tokens')
  const model =
    m.kind === 'sense-voice'
      ? { senseVoice: { model: pick('.onnx'), language: 'auto', useInverseTextNormalization: 1 } }
      : m.kind === 'paraformer'
        ? { paraformer: { model: pick('.onnx') } }
        : // Whisper 不指定语言：让它自己判断，中英文都能说
          { whisper: { encoder: pick('encoder'), decoder: pick('decoder'), language: '', task: 'transcribe' } }
  return {
    featConfig: { sampleRate: SPEECH_RATE, featureDim: 80 },
    modelConfig: { ...model, tokens, numThreads: threads, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
  }
}

/** 录音交给服务端的采样率：所有模型都按 16kHz 单声道训练 */
export const SPEECH_RATE = 16000

/** 一次最多录多久（秒）：按住说话的场景用不到这么长，超过就自动停下识别 */
export const SPEECH_MAX_SECONDS = 120

/** 上传的录音最大字节数（16 位 PCM） */
export const SPEECH_MAX_BYTES = SPEECH_RATE * 2 * SPEECH_MAX_SECONDS

/** 浏览器录到的采样率（一般 44.1k / 48k）重采样到 16k：按区间求平均，比直接抽点少混叠 */
export function resample(input: Float32Array, from: number, to = SPEECH_RATE): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / (end - start)
  }
  return out
}

/** Float32 采样 → 16 位小端 PCM（上传体积减半） */
export function encodePcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

/** 16 位小端 PCM → Float32 采样（服务端交给识别库前用） */
export function decodePcm16(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.length / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}

/**
 * 识别结果整理：Whisper 偶尔会在开头带空格，SenseVoice 在没听清时可能只回一个标点；
 * 只剩标点和空白的结果当成「没听到内容」
 */
export function cleanTranscript(text: string) {
  const s = text.trim()
  return /^[\p{P}\s]*$/u.test(s) ? '' : s
}

/** 设置页看到的状态 */
export interface SpeechStatus {
  /** 这台电脑有没有识别库的预编译包 */
  supported: boolean
  platform: string
  /** 识别库下载好了 */
  runtime: boolean
  /** 已经下载好的模型 id */
  models: string[]
  /** 模型和识别库放在哪 */
  dir: string
  job?: SpeechJob
}

/** 下载进度（同一时间只有一个） */
export interface SpeechJob {
  id: string
  model: string
  status: 'running' | 'done' | 'failed'
  step: string
  progress?: { done: number; total: number }
  error?: string
}
