import { t } from './i18n.ts'

/**
 * 语音朗读（和语音输入分开设置）：本机用开源的 Kokoro 模型（sherpa-onnx 转好的 onnx）把文字念出来，不联网。
 * 识别库和语音输入共用同一份 sherpa-onnx（见 server/speech.ts），已经下过就不再下。
 * 没下载模型、或者在线演示里，用浏览器自带的语音（speechSynthesis）。
 */

/** 朗读引擎：本机模型（开源 Kokoro）或浏览器自带的语音 */
export const TTS_ENGINES = ['local', 'browser'] as const
export type TtsEngine = (typeof TTS_ENGINES)[number]

export interface TtsModel {
  id: string
  name: string
  /** 适合什么场景 */
  use: string
  /** sherpa-onnx 发布的模型包（tar.bz2），解开后是 dir 这个目录 */
  archive: string
  dir: string
  /** 目录里的模型文件 */
  model: string
  /** 下载包大约多大（MB，只用来显示） */
  mb: number
  recommended?: boolean
  license: string
}

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'

/**
 * 可以选的模型：Kokoro v1.1 中文版（82M 参数，中英混读，103 个音色）。
 * 包名和大小对着 k2-fsa/sherpa-onnx 的 tts-models 发布核对过（int8 147MB、完整精度 365MB）
 */
export const TTS_MODELS: TtsModel[] = [
  {
    id: 'kokoro-int8-v1_1',
    name: 'Kokoro v1.1 中文（int8）',
    use: t('开源的 Kokoro 中文版：中英混读，55 个中文女声、45 个中文男声；体积小、普通 CPU 上也念得动'),
    archive: `${RELEASE}/kokoro-int8-multi-lang-v1_1.tar.bz2`,
    dir: 'kokoro-int8-multi-lang-v1_1',
    model: 'model.int8.onnx',
    mb: 147,
    recommended: true,
    license: 'Apache-2.0',
  },
  {
    id: 'kokoro-v1_1',
    name: 'Kokoro v1.1 中文（完整精度）',
    use: t('和上面是同一个模型的完整精度版：音质略好一点，体积大一倍多、也慢一些'),
    archive: `${RELEASE}/kokoro-multi-lang-v1_1.tar.bz2`,
    dir: 'kokoro-multi-lang-v1_1',
    model: 'model.onnx',
    mb: 365,
    license: 'Apache-2.0',
  },
]

export const DEFAULT_TTS_MODEL = TTS_MODELS[0].id
export const TTS_MODEL_IDS = TTS_MODELS.map((m) => m.id) as [string, ...string[]]
export const ttsModel = (id: string) => TTS_MODELS.find((m) => m.id === id)

/**
 * Kokoro v1.1 的音色：编号是模型里的 speaker id，名字取自模型元数据（id2speaker）：
 * 0–2 是英文（af_maple、af_sol、bf_vale），3–57 是中文女声 zf_xxx，58–102 是中文男声 zm_xxx
 */
const ZF = [
  1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 32, 36, 38, 39, 40, 42, 43, 44, 46, 47, 48, 49, 51,
  59, 60, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 83, 84, 85, 86, 87, 88, 90, 92, 93, 94, 99,
]
const ZM = [
  9, 10, 11, 12, 13, 14, 15, 16, 20, 25, 29, 30, 31, 33, 34, 35, 37, 41, 45, 50, 52, 53, 54, 55, 56, 57, 58, 61, 62, 63,
  64, 65, 66, 68, 69, 80, 81, 82, 89, 91, 95, 96, 97, 98, 100,
]

export interface TtsVoice {
  sid: number
  /** 模型里的名字（zf_001 这类），界面上显示 */
  name: string
  group: 'zf' | 'zm' | 'en'
}

const pad = (n: number) => String(n).padStart(3, '0')
export const TTS_VOICES: TtsVoice[] = [
  ...['af_maple', 'af_sol', 'bf_vale'].map((name, sid) => ({ sid, name, group: 'en' as const })),
  ...ZF.map((n, i) => ({ sid: 3 + i, name: `zf_${pad(n)}`, group: 'zf' as const })),
  ...ZM.map((n, i) => ({ sid: 3 + ZF.length + i, name: `zm_${pad(n)}`, group: 'zm' as const })),
]
/** 默认音色：第一个中文女声 */
export const DEFAULT_TTS_VOICE = 3
export const TTS_VOICE_COUNT = TTS_VOICES.length

export const ttsVoiceGroupLabel = (g: TtsVoice['group']) =>
  g === 'zf' ? t('中文女声') : g === 'zm' ? t('中文男声') : t('英文')

/** 语速范围（1 是正常） */
export const TTS_SPEED_MIN = 0.5
export const TTS_SPEED_MAX = 2

/** 一次请求最多念多少字：界面按句切好再一段段要，单段太长生成要等很久才出声 */
export const TTS_MAX_CHARS = 400

/**
 * 交给 sherpa-onnx OfflineTts 的配置。file 把文件名换成模型目录里的完整路径，
 * 放在 shared 里是为了不加载原生库也能测
 */
export function ttsConfig(m: TtsModel, file: (name: string) => string, threads: number) {
  return {
    model: {
      kokoro: {
        model: file(m.model),
        voices: file('voices.bin'),
        tokens: file('tokens.txt'),
        dataDir: file('espeak-ng-data'),
        dictDir: file('dict'),
        // 英文词典在前、中文在后：中英混读时两边的词都认得
        lexicon: [file('lexicon-us-en.txt'), file('lexicon-zh.txt')].join(','),
      },
      numThreads: threads,
      provider: 'cpu',
      debug: false,
    },
    // 日期、电话、数字按中文的读法念
    ruleFsts: ['date-zh.fst', 'phone-zh.fst', 'number-zh.fst'].map(file).join(','),
    maxNumSentences: 1,
  }
}

/** 一个模型装好了要有的文件（判断下载是否完整） */
export const ttsModelFiles = (m: TtsModel) => [m.model, 'voices.bin', 'tokens.txt', 'lexicon-zh.txt']

/** Float32 采样 → 16 位单声道 WAV（浏览器直接能播） */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(out.buffer)
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // 单声道
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

/** 朗读的下载和模型状态（和语音输入的 SpeechStatus 一个形状，共用识别库） */
export interface TtsStatus {
  supported: boolean
  platform: string
  /** 识别库（和语音输入共用）下好了没有 */
  runtime: boolean
  /** 下好的模型 */
  models: string[]
  dir: string
  job?: {
    id: string
    model: string
    status: 'running' | 'done' | 'failed'
    step: string
    progress?: { done: number; total: number }
    error?: string
  }
}
