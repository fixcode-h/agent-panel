/**
 * 视频截帧：用户把视频放进输入框时，不把视频交给 Agent，而是在弹窗里截出几张帧图片发给 AI 看
 * （用户 2026-11-05 定的：CLI 和模型都收不了视频，发路径只会让 Agent 自己想办法）。
 *
 * 这里放前后端共用的纯逻辑：认视频文件、解析 FFmpeg 的探测输出、自动截帧怎么挑时间点、
 * 帧图片的清晰度评分、帧的文件名。真正调用 FFmpeg 的在 server/video/。
 *
 * 原视频只读：截帧、增强的输出都写在数据目录的 video-frames/ 下，不拷视频、不改视频。
 */
import { z } from 'zod'

/** 认作视频的扩展名（和 web/src/lib/file-ref.ts 的 media 类里视频那几种一致，另加常见录屏格式） */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|mpg|mpeg|ts|3gp)$/i

/** 按文件名（或 mime）判断是不是视频 */
export const isVideoFile = (name: string, mime = '') => mime.startsWith('video/') || VIDEO_EXT.test(name)

/** 浏览器 <video> 一般能直接播的容器；其余（mkv、avi…）播放器可能放不出来，改用 FFmpeg 取的画面预览 */
export const browserPlayable = (name: string) => /\.(mp4|m4v|webm|mov|ogv)$/i.test(name)

/** 视频的基本信息：探测出来的 */
export interface VideoInfo {
  /** 秒；读不出来时为 0 */
  duration: number
  width: number
  height: number
  fps: number
}

/**
 * 解析 `ffmpeg -hide_banner -i 文件` 的输出（不用 ffprobe：下载的 FFmpeg 只有一个可执行文件）。
 * 例：`Duration: 00:01:42.33, start: 0.000000, bitrate: 1234 kb/s`、
 * `Stream #0:0(und): Video: h264 (High), yuv420p(tv), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr`
 */
export function parseProbe(out: string): VideoInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out)
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
  const line = out.split('\n').find((l) => /Stream #.*Video:/.test(l)) ?? ''
  // 尺寸取「数字x数字」里第一组像样的（编码参数里也可能有 0x31637661 这种 fourcc，要排除 0x 开头）
  const size = /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,[]|$)/.exec(line)
  const fps = /([\d.]+)\s*fps/.exec(line) ?? /([\d.]+)\s*tbr/.exec(line)
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    fps: fps ? Number(fps[1]) : 0,
  }
}

/** FFmpeg 打印的 `-version` 第一行里的版本号（`ffmpeg version 6.0-static …` → `6.0-static`） */
export const ffmpegVersion = (out: string) => /ffmpeg version (\S+)/.exec(out)?.[1] ?? ''

/** showinfo 滤镜每帧一行，取出 pts_time（秒） */
export function showinfoTimes(out: string): number[] {
  const times: number[] = []
  for (const m of out.matchAll(/pts_time:\s*([\d.]+)/g)) {
    const v = Number(m[1])
    if (Number.isFinite(v)) times.push(v)
  }
  return times
}

/** 自动截帧的方式 */
export const AUTO_MODES = ['uniform', 'scene', 'screen'] as const
export type AutoMode = (typeof AUTO_MODES)[number]

/** 自动截帧一次最多几张：帧太多 AI 看不过来，也拖慢截帧，挑出要紧的几张就够 */
export const AUTO_MAX = 24

/** 均匀截帧：把时长平分成 n 段，取每段中间（不取 0 秒和最后一刻：开头常是黑屏，结尾常是停在最后的画面） */
export function uniformTimes(duration: number, n: number): number[] {
  if (!(duration > 0) || n < 1) return []
  return Array.from({ length: n }, (_, i) => round3(((i + 0.5) * duration) / n))
}

/**
 * 从「画面有变化的时间点」里挑 n 个，尽量铺满整段：
 * 候选多于 n 时，把时长平分成 n 段，每段取离段中间最近的候选（没有候选的段留空）；
 * 挑出来不够 n 个时，在相邻两帧间隔最大的地方补均匀的时间点。
 * 候选为空（静止画面、检测不到切换）时退回均匀截帧。
 */
export function pickTimes(candidates: number[], duration: number, n: number): number[] {
  if (!(duration > 0) || n < 1) return []
  const sorted = [...new Set(candidates.filter((x) => x >= 0 && x <= duration).map(round3))].sort((a, b) => a - b)
  if (!sorted.length) return uniformTimes(duration, n)
  const out: number[] = []
  if (sorted.length <= n) out.push(...sorted)
  else {
    const seg = duration / n
    for (let i = 0; i < n; i++) {
      const from = i * seg
      const to = from + seg
      const mid = from + seg / 2
      const inSeg = sorted.filter((x) => x >= from && (x < to || (i === n - 1 && x <= to)))
      if (!inSeg.length) continue
      out.push(inSeg.reduce((best, x) => (Math.abs(x - mid) < Math.abs(best - mid) ? x : best)))
    }
  }
  // 不够：每次在最大的空档中间补一个（两端也算空档）
  while (out.length < n) {
    out.sort((a, b) => a - b)
    const edges = [0, ...out, duration]
    let at = 0
    let gap = -1
    for (let i = 0; i + 1 < edges.length; i++) {
      const g = edges[i + 1] - edges[i]
      if (g > gap) {
        gap = g
        at = i
      }
    }
    // 空档已经小到 0.1 秒以内：视频太短，不再硬凑
    if (gap < 0.1) break
    out.push(round3((edges[at] + edges[at + 1]) / 2))
  }
  return out.sort((a, b) => a - b)
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * 一张灰度小图的清晰度：拉普拉斯算子响应的方差（越大边缘越锐利）。
 * 自动截帧时在目标时间前后取几帧，挑分数最高的那张，避开运动模糊、转场的半透明画面。
 */
export function sharpness(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3 || gray.length < width * height) return 0
  let sum = 0
  let sq = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width]
      sum += v
      sq += v * v
      n++
    }
  }
  const mean = sum / n
  return sq / n - mean * mean
}

/** 原始灰度流（rawvideo gray）切成一帧一帧，挑最清楚的那一帧的下标；空流返回 -1 */
export function sharpestIndex(raw: Uint8Array, width: number, height: number): number {
  const size = width * height
  if (!size || raw.length < size) return -1
  let best = -1
  let score = -1
  for (let i = 0; (i + 1) * size <= raw.length; i++) {
    const s = sharpness(raw.subarray(i * size, (i + 1) * size), width, height)
    if (s > score) {
      score = s
      best = i
    }
  }
  return best
}

/** 时间显示：`01:02.3`（超过一小时 `1:01:02.3`） */
export function timeText(sec: number, digits = 1) {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = (s % 60).toFixed(digits).padStart(digits ? 3 + digits : 2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${String(m).padStart(2, '0')}:${rest}`
}

/**
 * 帧发给 AI 时的文件名：视频名 + 时间（`录屏-00m12.3s.png`），AI 从名字就知道是第几秒；
 * 增强过的加 -enhanced。不用冒号，Windows 文件名里不能有
 */
export function frameName(video: string, sec: number, enhanced = false) {
  const base = video.replace(/^.*[\\/]/, '')
  const stem = base.replace(/\.[^.]+$/, '') || 'video'
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(1).padStart(4, '0')
  return `${stem}-${String(m).padStart(2, '0')}m${s}s${enhanced ? '-enhanced' : ''}.png`
}

/** 一张截下来的帧 */
export const VideoFrame = z.object({
  id: z.string(),
  /** 在视频里的位置（秒） */
  time: z.number(),
  /** manual：用户手动截的，自动截帧、清除自动帧都不动它；auto：自动截的 */
  source: z.enum(['manual', 'auto']),
  /** 帧图片的绝对路径（数据目录 video-frames/ 下） */
  file: z.string(),
  width: z.number().default(0),
  height: z.number().default(0),
  /** 文件大小（字节）：放进输入框时附件要带大小 */
  bytes: z.number().default(0),
  /** 增强后的图片：有它时弹窗默认显示、默认发它 */
  enhanced: z
    .object({ method: z.string(), label: z.string(), file: z.string(), bytes: z.number().default(0) })
    .optional(),
})
export type VideoFrame = z.infer<typeof VideoFrame>

/** 一个视频的截帧记录：按「路径 + 大小 + 修改时间」认同一个视频，重新打开弹窗时手动截的帧还在 */
export interface VideoSession {
  key: string
  path: string
  name: string
  size: number
  info: VideoInfo
  frames: VideoFrame[]
}

/**
 * 自动截帧的进度：先整段分析画面（analyze，按已解码到的时间算比例），再一张张截（grab，done/total）。
 * 均匀模式不分析，直接从 grab 开始
 */
export interface AutoProgress {
  stage: 'analyze' | 'grab'
  /** analyze 时是 0~1 的比例；grab 时是已经截好几张 */
  done: number
  /** grab 时一共要截几张；analyze 时为 1 */
  total: number
}

/** ffmpeg 边跑边打的状态行里「time=00:01:02.50」：已经处理到第几秒；没有时 undefined */
export function ffmpegTime(chunk: string): number | undefined {
  let last: number | undefined
  for (const m of chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)) last = +m[1]! * 3600 + +m[2]! * 60 + +m[3]!
  return last
}

/** 帧按时间排；同一时刻手动的排前面 */
export const sortFrames = (list: VideoFrame[]) =>
  [...list].sort((a, b) => a.time - b.time || (a.source === b.source ? 0 : a.source === 'manual' ? -1 : 1))

/**
 * 自动截帧的结果并进已有的帧：自动帧整批换掉，手动帧无论如何都保留（用户要求）；
 * 新的自动帧和某张手动帧几乎同一时刻（0.15 秒内）时不重复放
 */
export function mergeAuto(old: VideoFrame[], auto: VideoFrame[]): VideoFrame[] {
  const manual = old.filter((f) => f.source === 'manual')
  const fresh = auto.filter((a) => !manual.some((m) => Math.abs(m.time - a.time) < 0.15))
  return sortFrames([...manual, ...fresh])
}

/** 增强方式：内置的 FFmpeg 放大锐化，以及本机 ComfyUI 里吃一张图的工作流 / 工作流链 */
export interface EnhanceMethod {
  id: string
  label: string
  /** 一句说明：在哪跑、要什么 */
  note: string
}

/** 内置增强：FFmpeg 2 倍 lanczos 放大 + 锐化，不用模型、几乎瞬间完成 */
export const FFMPEG_ENHANCE = 'ffmpeg-sharpen'

/** 增强方式 id：ComfyUI 工作流 `comfy:wf:<id>`、工作流链 `comfy:chain:<id>` */
export const comfyMethod = (kind: 'wf' | 'chain', id: string) => `comfy:${kind}:${id}`
export function parseComfyMethod(m: string): { kind: 'wf' | 'chain'; id: string } | null {
  const hit = /^comfy:(wf|chain):(.+)$/.exec(m)
  return hit ? { kind: hit[1] as 'wf' | 'chain', id: hit[2] } : null
}

/** FFmpeg 的下载地址：ffmpeg-static 发布的各平台单文件（gz），镜像用 npmmirror */
export const FFMPEG_RELEASE = 'b6.0'
const FFMPEG_PLATFORMS = [
  'win32-x64',
  'win32-ia32',
  'linux-x64',
  'linux-arm64',
  'linux-ia32',
  'darwin-x64',
  'darwin-arm64',
]
export function ffmpegDownloadUrl(platform: string, arch: string, mirror: boolean) {
  const key = `${platform}-${arch}`
  if (!FFMPEG_PLATFORMS.includes(key)) return ''
  const base = mirror
    ? 'https://registry.npmmirror.com/-/binary/ffmpeg-static'
    : 'https://github.com/eugeneware/ffmpeg-static/releases/download'
  return `${base}/${FFMPEG_RELEASE}/ffmpeg-${key}.gz`
}

/** FFmpeg 的状态：弹窗里没有 FFmpeg 时显示下载 */
export interface FfmpegStatus {
  /** 正在用的 ffmpeg 可执行文件；没有时为空 */
  path: string
  version: string
  /** 这台电脑有没有能下载的预编译包 */
  downloadable: boolean
  /** 下载进度 */
  job?: { done: number; total: number; error?: string; running: boolean }
}
