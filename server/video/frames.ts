/**
 * 视频截帧：按视频记一份截帧记录，手动截帧、自动截帧、清除、增强都在这里。
 *
 * 一个视频按「绝对路径 + 大小 + 修改时间」认（key），记录和帧图片放在数据目录 video-frames/<key>/：
 * 视频本身不拷、不改，FFmpeg 只把它当输入读。重新打开弹窗时读回这份记录，手动截的帧还在。
 * 帧发给 AI 时是普通的图片附件，由 server/attachments.ts 照图片的规矩拷进对话目录。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import {
  AUTO_MAX,
  VideoFrame,
  clampRange,
  isFullRange,
  isVideoFile,
  mergeAuto,
  parseProbe,
  rangePickTimes,
  rangeUniformTimes,
  sharpestIndex,
  showinfoTimes,
  sortFrames,
  ffmpegTime,
  type AutoMode,
  type AutoProgress,
  type VideoInfo,
  type VideoRange,
  type VideoSession,
} from '../../shared/video.ts'
import { DEFAULT_PREFS, NamedRange, VideoPrefs } from '../../shared/video-tools.ts'
import { enhanceMethods, enhanceOne } from './enhance.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from '../store.ts'
import { ffmpegBin, runFfmpeg } from './ffmpeg.ts'

export const framesRoot = () => path.join(DATA_DIR, 'video-frames')
export const sessionDir = (key: string) => path.join(framesRoot(), key)
const stateFile = (key: string) => path.join(sessionDir(key), 'state.json')

/** key 只能是我们自己算出来的十六进制串：拿它拼目录，不能让外面传进 `..` */
const validKey = (key: string) => /^[0-9a-f]{16}$/.test(key)

/** 正在自动截帧的视频的进度（按 key），截帧弹窗轮询它画进度条；做完就删 */
const autoProgress = new Map<string, AutoProgress>()
export const autoProgressOf = (key: string) => autoProgress.get(key) ?? null

/** 同一个视频的操作排队做：自动截帧还没写完时又点了手动截帧，记录不能互相覆盖 */
const queues = new Map<string, Promise<unknown>>()
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

export async function videoStat(file: string) {
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
export async function probe(full: string): Promise<VideoInfo> {
  const r = await runFfmpeg(await ffmpegBin(), ['-i', full], { timeoutMs: 20_000 })
  if (r.error) throw new Error(r.error)
  const info = parseProbe(r.stderr)
  if (!info.width) throw new Error(t('读不出视频画面：{error}', { error: r.stderr.trim().split('\n').pop() ?? '' }))
  return info
}

type SavedState = Pick<VideoSession, 'frames' | 'ranges' | 'prefs'>

async function readState(key: string, full: string): Promise<SavedState> {
  const raw = (await readJson(stateFile(key))) as
    { path?: string; frames?: unknown[]; ranges?: unknown[]; prefs?: unknown } | undefined
  if (!raw || raw.path !== full) return { frames: [], ranges: [], prefs: DEFAULT_PREFS }
  const frames = (Array.isArray(raw.frames) ? raw.frames : []).flatMap((x) => {
    const p = VideoFrame.safeParse(x)
    // 帧图片被清掉了（清空缓存）：这一条也不要了；增强图、标注图没了只去掉那一份
    if (!p.success || !existsSync(p.data.file)) return []
    const f = { ...p.data }
    if (f.enhanced && !existsSync(f.enhanced.file)) f.enhanced = undefined
    if (f.annotated && !existsSync(f.annotated.file)) f.annotated = undefined
    return [f]
  })
  const ranges = (Array.isArray(raw.ranges) ? raw.ranges : []).flatMap((x) => {
    const p = NamedRange.safeParse(x)
    return p.success ? [p.data] : []
  })
  const prefs = VideoPrefs.safeParse(raw.prefs ?? {})
  return { frames, ranges, prefs: prefs.success ? prefs.data : DEFAULT_PREFS }
}

export async function save(s: VideoSession) {
  await mkdir(sessionDir(s.key), { recursive: true })
  await writeJsonAtomic(stateFile(s.key), {
    path: s.path,
    name: s.name,
    frames: sortFrames(s.frames),
    ranges: s.ranges,
    prefs: s.prefs,
  })
}

/** 打开一个视频：探测信息，读回之前截过的帧、记下的范围和设置 */
export async function openVideo(file: string): Promise<VideoSession> {
  const { full, size, key } = await videoStat(file)
  const info = await probe(full)
  const st = await readState(key, full)
  return { key, path: full, name: path.basename(full), size, info, ...st, frames: sortFrames(st.frames) }
}

/** 按 key 取回会话：路径要和 key 对得上（视频换了内容、被改过时 key 就变了，要重新打开） */
export async function session(key: string, file: string): Promise<VideoSession> {
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

/**
 * 在 time 前后 0.25 秒里挑最清楚的那一刻（避开运动模糊、转场）；评不出来就用原来的时间。
 * 选了截帧范围时只在范围里挑，不会挑到范围外面去
 */
export async function sharpestNear(
  full: string,
  time: number,
  info: VideoInfo,
  range: VideoRange,
  signal?: AbortSignal,
) {
  const fps = 8
  const w = 160
  const h = Math.max(2, Math.round((w * info.height) / Math.max(1, info.width) / 2) * 2)
  const start = Math.max(range.start, time - 0.25)
  const len = Math.min(0.5, range.end - start)
  if (!(len > 0.05)) return time
  const r = await runFfmpeg(
    await ffmpegBin(),
    [
      '-ss',
      start.toFixed(3),
      '-t',
      len.toFixed(3),
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
  return i < 0 ? time : Math.min(range.end, start + i / fps)
}

/**
 * 自动截帧的候选时间点：画面变化（场景切换分数）或录屏（去掉和上一帧几乎一样的画面）。
 * 选了范围时只解码这一段（-ss 放在 -i 前面快速跳到起点，-t 限定长度），返回的时间是相对范围起点的秒数
 */
export async function candidates(
  full: string,
  mode: AutoMode,
  range: VideoRange,
  signal?: AbortSignal,
  onRatio?: (r: number) => void,
) {
  if (mode === 'uniform') return []
  const len = range.end - range.start
  const pick =
    mode === 'scene'
      ? "fps=5,scale=320:-2,split[a][b];[a]select='gt(scene\\,0.3)',showinfo[o]"
      : 'fps=4,scale=480:-2,split[a][b];[a]mpdecimate=hi=64*24:lo=64*8:frac=0.1,showinfo[o]'
  // 整段解码一遍：给足时间（大约按视频时长算），长视频也不会被提前掐掉
  const timeoutMs = Math.max(60_000, len * 3000)
  // 进度：ffmpeg 状态行的「time=…」按输出算，挑帧那一路画面没变化时一帧都不出、一直是 N/A，
  // 所以分出一路每秒一帧的画面单独输出到 null，它的 time 就是已经解码到的位置，除以时长就是分析到哪儿了
  const onStderr = (chunk: string) => {
    const at = ffmpegTime(chunk)
    if (at !== undefined && len > 0) onRatio?.(Math.min(1, at / len))
  }
  const graph = `[0:v]${pick};[b]fps=1[p]`
  const r = await runFfmpeg(
    await ffmpegBin(),
    [
      ...(range.start > 0 ? ['-ss', range.start.toFixed(3)] : []),
      '-t',
      len.toFixed(3),
      '-i',
      full,
      '-an',
      '-filter_complex',
      graph,
      '-map',
      '[o]',
      '-f',
      'null',
      '-',
      '-map',
      '[p]',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs, signal, onStderr },
  )
  if (r.error) throw new Error(t('分析画面失败：{error}', { error: r.error }))
  return showinfoTimes(r.stderr)
}

/**
 * 自动截帧：在 range（不传就是整段）里按 mode 挑 count 个时间点截图。
 * 范围里原来的自动帧整批换掉，范围外的自动帧和所有手动帧都留着
 */
export async function autoFrames(
  key: string,
  file: string,
  mode: AutoMode,
  count: number,
  signal?: AbortSignal,
  want?: Partial<VideoRange> | null,
) {
  return serial(key, async () => {
    const s = await session(key, file)
    const n = Math.min(Math.max(1, Math.round(count)), AUTO_MAX)
    const range = clampRange(want, s.info.duration)
    const partial = !isFullRange(range, s.info.duration)
    const fresh: VideoFrame[] = []
    try {
      if (mode !== 'uniform') autoProgress.set(key, { stage: 'analyze', done: 0, total: 1 })
      const found = await candidates(s.path, mode, range, signal, (r) =>
        autoProgress.set(key, { stage: 'analyze', done: r, total: 1 }),
      )
      const times = mode === 'uniform' ? rangeUniformTimes(range, n) : rangePickTimes(found, range, n)
      autoProgress.set(key, { stage: 'grab', done: 0, total: times.length })
      for (const t0 of times) {
        if (signal?.aborted) throw new Error(t('已取消'))
        const at = await sharpestNear(s.path, t0, s.info, range, signal)
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
    // 自动帧整批换掉（选了范围时只换范围里的），手动帧保留
    const old = s.frames.filter((f) => f.source === 'auto')
    s.frames = mergeAuto(s.frames, fresh, partial ? range : undefined)
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

export async function removeFiles(list: VideoFrame[]) {
  await Promise.all(
    list
      .flatMap((f) => [f.file, f.enhanced?.file, f.annotated?.file])
      .flatMap((x) => (x ? [rm(x, { force: true })] : [])),
  )
}

/** 底图换了（增强、去掉增强）：画好的标注图过期了，删掉；标注本身留着，发送前按新底图重画 */
async function dropAnnotated(f: VideoFrame) {
  if (!f.annotated) return
  await rm(f.annotated.file, { force: true })
  f.annotated = undefined
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

/**
 * 一次增强几张：ComfyUI 这几张一起排进它的队列（模型只加载一次，两张之间没有空档），FFmpeg 几张并行。
 * 以前前端一张一张发请求，每张都要等上一张回来再提交，ComfyUI 中间总在空等（用户 2026-11-07 要的批量提交）
 */
const ENHANCE_PARALLEL = 3

/** 增强选中的帧；已经增强过的换成新方式的结果。进度（做完几张、正在做哪张）记在 autoProgress 里给弹窗轮询 */
export async function enhanceFrames(key: string, file: string, ids: string[], method: string, signal?: AbortSignal) {
  return serial(key, async () => {
    const s = await session(key, file)
    const label = (await enhanceMethods()).find((m) => m.id === method)?.label ?? method
    const todo = s.frames.filter((f) => ids.includes(f.id))
    const running = new Set<string>()
    const finished: string[] = []
    const report = () =>
      autoProgress.set(key, {
        stage: 'enhance',
        done: finished.length,
        total: todo.length,
        running: [...running],
        finished: [...finished],
      })
    report()
    // 存盘也排队：几张同时做完时不互相覆盖
    let saving = Promise.resolve()
    const one = async (f: VideoFrame) => {
      if (signal?.aborted) throw new Error(t('已取消'))
      running.add(f.id)
      report()
      const buf = await enhanceOne(method, f, signal)
      const out = path.join(sessionDir(key), `${f.id}-enhanced-${randomUUID().slice(0, 6)}.png`)
      await writeFile(out, buf)
      if (f.enhanced) await rm(f.enhanced.file, { force: true })
      await dropAnnotated(f)
      f.enhanced = { method, label, file: out, bytes: buf.length }
      running.delete(f.id)
      finished.push(f.id)
      report()
      // 每张做完就记一次：中途失败时已经做好的不丢
      saving = saving.then(() => save(s))
      await saving
    }
    try {
      let next = 0
      const worker = async () => {
        while (next < todo.length) await one(todo[next++])
      }
      await Promise.all(Array.from({ length: Math.min(ENHANCE_PARALLEL, todo.length) }, worker))
    } finally {
      autoProgress.delete(key)
      await saving.catch(() => {})
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
      await dropAnnotated(f)
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
