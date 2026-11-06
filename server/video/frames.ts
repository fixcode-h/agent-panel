/**
 * 视频截帧：按视频记一份截帧记录，手动截帧、自动截帧、清除、增强都在这里。
 *
 * 一个视频按「绝对路径 + 大小 + 修改时间」认（key），记录和帧图片放在数据目录 video-frames/<key>/：
 * 视频本身不拷、不改，FFmpeg 只把它当输入读。重新打开弹窗时读回这份记录，手动截的帧还在。
 * 帧发给 AI 时是普通的图片附件，由 server/attachments.ts 照图片的规矩拷进对话目录。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import { chainSize, needsInputImage } from '../../shared/local-image.ts'
import {
  AUTO_MAX,
  FFMPEG_ENHANCE,
  VideoFrame,
  comfyMethod,
  isVideoFile,
  mergeAuto,
  parseComfyMethod,
  parseProbe,
  pickTimes,
  sharpestIndex,
  showinfoTimes,
  sortFrames,
  uniformTimes,
  ffmpegTime,
  type AutoMode,
  type AutoProgress,
  type EnhanceMethod,
  type VideoInfo,
  type VideoSession,
} from '../../shared/video.ts'
import { allWorkflows, localGenerateChain, userChains } from '../comfy.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from '../store.ts'
import { ffmpegBin, runFfmpeg } from './ffmpeg.ts'

export const framesRoot = () => path.join(DATA_DIR, 'video-frames')
const sessionDir = (key: string) => path.join(framesRoot(), key)
const stateFile = (key: string) => path.join(sessionDir(key), 'state.json')

/** key 只能是我们自己算出来的十六进制串：拿它拼目录，不能让外面传进 `..` */
const validKey = (key: string) => /^[0-9a-f]{16}$/.test(key)

/** 正在自动截帧的视频的进度（按 key），截帧弹窗轮询它画进度条；做完就删 */
const autoProgress = new Map<string, AutoProgress>()
export const autoProgressOf = (key: string) => autoProgress.get(key) ?? null

/** 同一个视频的操作排队做：自动截帧还没写完时又点了手动截帧，记录不能互相覆盖 */
const queues = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn)
  queues.set(
    key,
    next.catch(() => {}),
  )
  return next
}

/** PNG 文件头里的宽高（IHDR 紧跟在 8 字节签名后面） */
function pngSize(buf: Buffer) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function videoStat(file: string) {
  const full = path.resolve(file)
  if (!isVideoFile(full)) throw new Error(t('「{name}」不是视频文件', { name: path.basename(full) }))
  const s = await stat(full).catch(() => null)
  if (!s?.isFile()) throw new Error(t('视频已经不在了：{path}', { path: full }))
  const key = createHash('sha1')
    .update(`${full}|${s.size}|${Math.round(s.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16)
  return { full, size: s.size, key }
}

/** 读视频的时长、尺寸、帧率：`ffmpeg -i` 没有输出文件时退出码是 1，信息在 stderr 里 */
async function probe(full: string): Promise<VideoInfo> {
  const r = await runFfmpeg(await ffmpegBin(), ['-i', full], { timeoutMs: 20_000 })
  if (r.error) throw new Error(r.error)
  const info = parseProbe(r.stderr)
  if (!info.width) throw new Error(t('读不出视频画面：{error}', { error: r.stderr.trim().split('\n').pop() ?? '' }))
  return info
}

async function readState(key: string, full: string): Promise<VideoFrame[]> {
  const raw = (await readJson(stateFile(key))) as { path?: string; frames?: unknown[] } | undefined
  if (!raw || raw.path !== full || !Array.isArray(raw.frames)) return []
  return raw.frames.flatMap((x) => {
    const p = VideoFrame.safeParse(x)
    // 帧图片被清掉了（清空缓存）：这一条也不要了；增强图没了只去掉增强
    if (!p.success || !existsSync(p.data.file)) return []
    const f = p.data
    return [f.enhanced && !existsSync(f.enhanced.file) ? { ...f, enhanced: undefined } : f]
  })
}

async function save(s: VideoSession) {
  await mkdir(sessionDir(s.key), { recursive: true })
  await writeJsonAtomic(stateFile(s.key), { path: s.path, name: s.name, frames: sortFrames(s.frames) })
}

/** 打开一个视频：探测信息，读回之前截过的帧 */
export async function openVideo(file: string): Promise<VideoSession> {
  const { full, size, key } = await videoStat(file)
  const info = await probe(full)
  return { key, path: full, name: path.basename(full), size, info, frames: sortFrames(await readState(key, full)) }
}

/** 按 key 取回会话：路径要和 key 对得上（视频换了内容、被改过时 key 就变了，要重新打开） */
async function session(key: string, file: string): Promise<VideoSession> {
  if (!validKey(key)) throw new Error(t('截帧记录不对，请重新打开这个视频'))
  const s = await openVideo(file)
  if (s.key !== key) throw new Error(t('视频在打开之后被改过，请重新打开'))
  return s
}

/** 截一帧原分辨率的 PNG 到数据目录；输出路径是新生成的，和原视频不可能是同一个文件 */
async function grab(full: string, key: string, time: number, info: VideoInfo) {
  const bin = await ffmpegBin()
  const at = Math.min(Math.max(0, time), Math.max(0, info.duration - 0.05))
  const id = randomUUID().slice(0, 12)
  const out = path.join(sessionDir(key), `${id}.png`)
  await mkdir(sessionDir(key), { recursive: true })
  const r = await runFfmpeg(
    bin,
    ['-ss', at.toFixed(3), '-i', full, '-frames:v', '1', '-an', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'],
    {
      timeoutMs: 30_000,
      maxOut: 200 * 1024 * 1024,
    },
  )
  if (r.error || !r.stdout.length)
    throw new Error(t('截帧失败：{error}', { error: r.error ?? (r.stderr.trim().split('\n').pop() || '') }))
  await writeFile(out, r.stdout)
  return { id, file: out, time: at, bytes: r.stdout.length, ...pngSize(r.stdout) }
}

/** 在 time 前后 0.25 秒里挑最清楚的那一刻（避开运动模糊、转场）；评不出来就用原来的时间 */
async function sharpestNear(full: string, time: number, info: VideoInfo, signal?: AbortSignal) {
  const fps = 8
  const w = 160
  const h = Math.max(2, Math.round((w * info.height) / Math.max(1, info.width) / 2) * 2)
  const start = Math.max(0, time - 0.25)
  const r = await runFfmpeg(
    await ffmpegBin(),
    [
      '-ss',
      start.toFixed(3),
      '-t',
      '0.5',
      '-i',
      full,
      '-an',
      '-vf',
      `fps=${fps},scale=${w}:${h},format=gray`,
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { timeoutMs: 20_000, signal, maxOut: 20 * 1024 * 1024 },
  )
  if (r.error) return time
  const i = sharpestIndex(new Uint8Array(r.stdout), w, h)
  return i < 0 ? time : Math.min(info.duration, start + i / fps)
}

/** 自动截帧的候选时间点：画面变化（场景切换分数）或录屏（去掉和上一帧几乎一样的画面） */
async function candidates(
  full: string,
  mode: AutoMode,
  info: VideoInfo,
  signal?: AbortSignal,
  onRatio?: (r: number) => void,
) {
  if (mode === 'uniform') return []
  const pick =
    mode === 'scene'
      ? "fps=5,scale=320:-2,split[a][b];[a]select='gt(scene\\,0.3)',showinfo[o]"
      : 'fps=4,scale=480:-2,split[a][b];[a]mpdecimate=hi=64*24:lo=64*8:frac=0.1,showinfo[o]'
  // 整段解码一遍：给足时间（大约按视频时长算），长视频也不会被提前掐掉
  const timeoutMs = Math.max(60_000, info.duration * 3000)
  // 进度：ffmpeg 状态行的「time=…」按输出算，挑帧那一路画面没变化时一帧都不出、一直是 N/A，
  // 所以分出一路每秒一帧的画面单独输出到 null，它的 time 就是已经解码到的位置，除以时长就是分析到哪儿了
  const onStderr = (chunk: string) => {
    const at = ffmpegTime(chunk)
    if (at !== undefined && info.duration > 0) onRatio?.(Math.min(1, at / info.duration))
  }
  const graph = `[0:v]${pick};[b]fps=1[p]`
  const r = await runFfmpeg(
    await ffmpegBin(),
    ['-i', full, '-an', '-filter_complex', graph, '-map', '[o]', '-f', 'null', '-', '-map', '[p]', '-f', 'null', '-'],
    { timeoutMs, signal, onStderr },
  )
  if (r.error) throw new Error(t('分析画面失败：{error}', { error: r.error }))
  return showinfoTimes(r.stderr)
}

export async function autoFrames(key: string, file: string, mode: AutoMode, count: number, signal?: AbortSignal) {
  return serial(key, async () => {
    const s = await session(key, file)
    const n = Math.min(Math.max(1, Math.round(count)), AUTO_MAX)
    const fresh: VideoFrame[] = []
    try {
      if (mode !== 'uniform') autoProgress.set(key, { stage: 'analyze', done: 0, total: 1 })
      const found = await candidates(s.path, mode, s.info, signal, (r) =>
        autoProgress.set(key, { stage: 'analyze', done: r, total: 1 }),
      )
      const times = mode === 'uniform' ? uniformTimes(s.info.duration, n) : pickTimes(found, s.info.duration, n)
      autoProgress.set(key, { stage: 'grab', done: 0, total: times.length })
      for (const want of times) {
        if (signal?.aborted) throw new Error(t('已取消'))
        const at = await sharpestNear(s.path, want, s.info, signal)
        const g = await grab(s.path, key, at, s.info)
        fresh.push({ ...g, source: 'auto' })
        autoProgress.set(key, { stage: 'grab', done: fresh.length, total: times.length })
      }
    } catch (e) {
      // 截到一半失败：这次截出来的都删掉，原来的帧不动
      await Promise.all(fresh.map((f) => rm(f.file, { force: true })))
      throw e
    } finally {
      autoProgress.delete(key)
    }
    // 自动帧整批换掉，手动帧保留
    const old = s.frames.filter((f) => f.source === 'auto')
    s.frames = mergeAuto(s.frames, fresh)
    await save(s)
    await removeFiles(old.filter((f) => !s.frames.includes(f)))
    return s
  })
}

export async function manualFrame(key: string, file: string, time: number) {
  return serial(key, async () => {
    const s = await session(key, file)
    const g = await grab(s.path, key, time, s.info)
    s.frames = sortFrames([...s.frames, { ...g, source: 'manual' }])
    await save(s)
    return s
  })
}

async function removeFiles(list: VideoFrame[]) {
  await Promise.all(
    list.flatMap((f) => [rm(f.file, { force: true }), f.enhanced ? rm(f.enhanced.file, { force: true }) : []]).flat(),
  )
}

/** 删帧：which 是 manual / auto 时清掉这一类，ids 给了时只删这几张 */
export async function removeFrames(key: string, file: string, o: { which?: 'manual' | 'auto'; ids?: string[] }) {
  return serial(key, async () => {
    const s = await session(key, file)
    const gone = s.frames.filter((f) => (o.ids ? o.ids.includes(f.id) : f.source === o.which))
    s.frames = s.frames.filter((f) => !gone.includes(f))
    await save(s)
    await removeFiles(gone)
    return s
  })
}

/** 能用的增强方式：内置 FFmpeg 锐化 + ComfyUI 里吃一张图的工作流和工作流链 */
export async function enhanceMethods(): Promise<EnhanceMethod[]> {
  const out: EnhanceMethod[] = [
    { id: FFMPEG_ENHANCE, label: t('放大锐化（FFmpeg）'), note: t('2 倍放大再锐化，不用模型，马上出结果') },
  ]
  const workflows = await allWorkflows().catch(() => [])
  for (const w of workflows)
    if (needsInputImage(w.graph))
      out.push({ id: comfyMethod('wf', w.id), label: w.name, note: t('本机 ComfyUI 工作流') })
  const byId = new Map(workflows.map((w) => [w.id, w]))
  for (const c of await userChains().catch(() => [])) {
    const first = byId.get(c.steps[0]?.workflowId ?? '')
    if (first && needsInputImage(first.graph))
      out.push({ id: comfyMethod('chain', c.id), label: c.name, note: t('本机 ComfyUI 工作流链') })
  }
  return out
}

/** 增强一张帧图，返回增强图的内容 */
async function enhanceOne(method: string, frame: VideoFrame, signal?: AbortSignal): Promise<Buffer> {
  if (method === FFMPEG_ENHANCE) {
    // 太大的图只放大到长边 4096：再大模型也看不过来，只会白占 token
    const scale = Math.max(frame.width, frame.height) * 2 > 4096 ? 4096 / Math.max(frame.width, frame.height, 1) : 2
    const r = await runFfmpeg(
      await ffmpegBin(),
      [
        '-i',
        frame.file,
        '-vf',
        `scale=trunc(iw*${scale.toFixed(4)}/2)*2:trunc(ih*${scale.toFixed(4)}/2)*2:flags=lanczos,unsharp=5:5:0.8:5:5:0`,
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1',
      ],
      { timeoutMs: 60_000, signal, maxOut: 300 * 1024 * 1024 },
    )
    if (r.error || !r.stdout.length)
      throw new Error(t('增强失败：{error}', { error: r.error ?? r.stderr.trim().split('\n').pop() ?? '' }))
    return r.stdout
  }
  const comfy = parseComfyMethod(method)
  if (!comfy) throw new Error(t('不认识的增强方式：{id}', { id: method }))
  const chain =
    comfy.kind === 'chain'
      ? (await userChains()).find((c) => c.id === comfy.id)
      : { id: `video-${comfy.id}`, name: comfy.id, steps: [{ workflowId: comfy.id, prompt: '' }], updatedAt: '' }
  if (!chain) throw new Error(t('工作流链已经不在了，请重新选一种增强方式'))
  const images: Buffer[] = []
  await localGenerateChain(
    {
      chain,
      image: await readFile(frame.file),
      prompt: '',
      negative: '',
      ...chainSize(frame.width, frame.height),
      count: 1,
      onImage: (b) => images.push(b),
    },
    signal ?? new AbortController().signal,
  )
  if (!images[0]) throw new Error(t('ComfyUI 没有返回图片'))
  return images[0]
}

/** 增强选中的帧；已经增强过的换成新方式的结果 */
export async function enhanceFrames(key: string, file: string, ids: string[], method: string, signal?: AbortSignal) {
  return serial(key, async () => {
    const s = await session(key, file)
    const label = (await enhanceMethods()).find((m) => m.id === method)?.label ?? method
    for (const f of s.frames) {
      if (!ids.includes(f.id)) continue
      if (signal?.aborted) throw new Error(t('已取消'))
      const buf = await enhanceOne(method, f, signal)
      const out = path.join(sessionDir(key), `${f.id}-enhanced-${randomUUID().slice(0, 6)}.png`)
      await writeFile(out, buf)
      if (f.enhanced) await rm(f.enhanced.file, { force: true })
      f.enhanced = { method, label, file: out, bytes: buf.length }
      // 每张做完就记一次：中途失败时已经做好的不丢
      await save(s)
    }
    return s
  })
}

/** 去掉增强（回到原图）；ids 不给时全部去掉 */
export async function clearEnhanced(key: string, file: string, ids?: string[]) {
  return serial(key, async () => {
    const s = await session(key, file)
    for (const f of s.frames) {
      if (!f.enhanced || (ids && !ids.includes(f.id))) continue
      await rm(f.enhanced.file, { force: true })
      f.enhanced = undefined
    }
    await save(s)
    return s
  })
}

/** 播放器放不出来的格式（mkv、avi…）：取这一刻的画面当预览（缩到 960 宽的 JPEG） */
export async function previewAt(file: string, time: number) {
  const { full } = await videoStat(file)
  const r = await runFfmpeg(
    await ffmpegBin(),
    [
      '-ss',
      Math.max(0, time).toFixed(3),
      '-i',
      full,
      '-frames:v',
      '1',
      '-an',
      '-vf',
      'scale=960:-2',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    { timeoutMs: 20_000, maxOut: 20 * 1024 * 1024 },
  )
  if (r.error || !r.stdout.length) throw new Error(r.error ?? t('取不到这一刻的画面'))
  return r.stdout
}

/** 播放用：只放行视频文件，返回绝对路径和大小 */
export async function streamable(file: string) {
  const { full, size } = await videoStat(file)
  return { full, size }
}
