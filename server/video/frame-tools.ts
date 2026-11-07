/**
 * 截帧弹窗的进阶操作（用户 2026-11-07 要的）：记住命名范围和设置、帧上标注、相似帧去重、帧差高亮。
 * 纯逻辑（哈希、去重分组、找变化的框、标注的结构）在 shared/video-tools.ts；这里读图、写盘。
 * 和 frames.ts 共用同一个视频的操作队列，记录不会互相覆盖。
 */
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import { sharpness, sortFrames, type VideoFrame } from '../../shared/video.ts'
import {
  DIFF_W,
  FrameShape,
  HASH_H,
  HASH_W,
  NamedRange,
  RANGES_MAX,
  SHAPES_MAX,
  VideoPrefs,
  dHash,
  diffBoxes,
  similarToDrop,
  type DiffBox,
} from '../../shared/video-tools.ts'
import { ffmpegBin, runFfmpeg } from './ffmpeg.ts'
import { removeFiles, save, serial, session, sessionDir } from './frames.ts'

/** 一张图缩成 w×h 的灰度原始数据；读不出来时返回空 */
async function grayOf(file: string, w: number, h: number) {
  const r = await runFfmpeg(
    await ffmpegBin(),
    ['-i', file, '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'],
    { timeoutMs: 20_000, maxOut: w * h * 2 },
  )
  return !r.error && r.stdout.length >= w * h ? new Uint8Array(r.stdout) : null
}

/** 记下命名范围和弹窗设置（弹窗里改了就存，重新打开还在） */
export async function saveMeta(key: string, file: string, o: { ranges?: unknown; prefs?: unknown }) {
  return serial(key, async () => {
    const s = await session(key, file)
    if (Array.isArray(o.ranges))
      s.ranges = o.ranges
        .flatMap((x) => {
          const p = NamedRange.safeParse(x)
          return p.success && p.data.end > p.data.start ? [p.data] : []
        })
        .slice(0, RANGES_MAX)
    if (o.prefs && typeof o.prefs === 'object') {
      const p = VideoPrefs.safeParse({ ...s.prefs, ...o.prefs })
      if (p.success) s.prefs = p.data
    }
    await save(s)
    return s
  })
}

/** 改一张帧的标注；标注变了，之前画好的标注图就不对了，删掉（发送前按新的重画） */
export async function setShapes(key: string, file: string, id: string, shapes: unknown) {
  return serial(key, async () => {
    const s = await session(key, file)
    const f = s.frames.find((x) => x.id === id)
    if (!f) throw new Error(t('这一帧已经不在了'))
    const list = (Array.isArray(shapes) ? shapes : []).flatMap((x) => {
      const p = FrameShape.safeParse(x)
      return p.success ? [p.data] : []
    })
    f.shapes = list.slice(0, SHAPES_MAX)
    if (!f.shapes.length) f.shapes = undefined
    if (f.annotated) {
      await rm(f.annotated.file, { force: true })
      f.annotated = undefined
    }
    await save(s)
    return s
  })
}

/**
 * 存浏览器画好的标注图（PNG，base64）：from 是画在哪张底图上。只认 PNG，大小有上限；
 * 文件名是新生成的，写在这个视频自己的目录里
 */
export async function saveAnnotated(key: string, file: string, id: string, from: string, png: string) {
  return serial(key, async () => {
    const s = await session(key, file)
    const f = s.frames.find((x) => x.id === id)
    if (!f) throw new Error(t('这一帧已经不在了'))
    if (from !== f.file && from !== f.enhanced?.file) throw new Error(t('标注的底图不对，请重新打开这一帧'))
    const buf = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64')
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.length > 80 * 1024 * 1024)
      throw new Error(t('标注图不是有效的 PNG'))
    const out = path.join(sessionDir(key), `${f.id}-annotated-${randomUUID().slice(0, 6)}.png`)
    await writeFile(out, buf)
    if (f.annotated) await rm(f.annotated.file, { force: true })
    f.annotated = { file: out, bytes: buf.length, from }
    await save(s)
    return s
  })
}

/** 帧的哈希和清晰度：没算过的现算并记下（用原图算，增强图不算） */
async function measure(f: VideoFrame) {
  if (f.hash && f.sharp !== undefined) return
  const tiny = await grayOf(f.file, HASH_W, HASH_H)
  f.hash = tiny ? dHash(tiny) : ''
  const w = 160
  const h = Math.max(2, Math.round((w * (f.height || 90)) / Math.max(1, f.width || 160) / 2) * 2)
  const g = await grayOf(f.file, w, h)
  f.sharp = g ? sharpness(g, w, h) : 0
}

/** 去掉几乎一样的自动帧（手动帧不动），返回去掉了几张 */
export async function dedupeFrames(key: string, file: string) {
  return serial(key, async () => {
    const s = await session(key, file)
    for (const f of s.frames) await measure(f)
    const drop = new Set(similarToDrop(s.frames.map((f) => ({ ...f, hash: f.hash ?? '', sharp: f.sharp ?? 0 }))))
    const gone = s.frames.filter((f) => drop.has(f.id))
    s.frames = sortFrames(s.frames.filter((f) => !drop.has(f.id)))
    await save(s)
    await removeFiles(gone)
    return { session: s, removed: gone.length }
  })
}

/**
 * 这张帧和时间上的前一张帧比，哪里变了：都缩成 DIFF_W 宽的灰度图逐格比较（尺寸按这一张的比例，前一张拉成一样大）。
 * 没有前一张（它是第一张）时返回空
 */
export async function frameDiff(
  key: string,
  file: string,
  id: string,
): Promise<{ prev: { id: string; time: number } | null; boxes: DiffBox[] }> {
  const s = await session(key, file)
  const list = sortFrames(s.frames)
  const i = list.findIndex((f) => f.id === id)
  if (i < 0) throw new Error(t('这一帧已经不在了'))
  const cur = list[i]
  const prev = list
    .slice(0, i)
    .reverse()
    .find((f) => Math.abs(f.time - cur.time) > 0.01)
  if (!prev) return { prev: null, boxes: [] }
  const w = DIFF_W
  const h = Math.max(2, Math.round((w * (cur.height || 9)) / Math.max(1, cur.width || 16) / 2) * 2)
  const [a, b] = await Promise.all([grayOf(prev.file, w, h), grayOf(cur.file, w, h)])
  if (!a || !b) throw new Error(t('读不出帧图片，比不了'))
  return { prev: { id: prev.id, time: prev.time }, boxes: diffBoxes(a, b, w, h) }
}
