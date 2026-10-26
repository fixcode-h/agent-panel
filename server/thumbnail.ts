import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { decodePng, encodePng, resize } from './image.ts'
import { CACHE_DIR } from './store.ts'

/**
 * 附件图片的缩略图。消息里一张图只有一行文字那么高（约 20px），却一直按原图取：
 * 上传目录里单图 100–300KB，首屏十几张就是几 MB。
 * 这里用 image.ts 已有的纯 JS PNG 解码、缩放、编码，不引入图片库（服务端要打成单文件、不能带原生模块）。
 * 解不开的格式（JPEG、WebP、隔行扫描的 PNG）、比目标还小的图、超过 MAX_THUMB_PIXELS 的超大图都返回 null，调用方直接用原图。
 */

/** 请求里允许的宽度上限：再大就不算缩略图了，没必要为它单独缓存一份 */
export const MAX_THUMB_WIDTH = 2048

/**
 * 愿意解码的最大像素数。解码和缩放都是同步计算（image.ts 允许到 4000 万像素），
 * 一张 6000×6000 的图会把 Node 主线程占住几百毫秒，期间所有接口都排队等它。
 * 超过这个数就回退原图：宁可多传几百 KB，也不让一张缩略图拖住整个服务端。
 */
export const MAX_THUMB_PIXELS = 12_000_000

const DIR = () => path.join(CACHE_DIR, 'thumbs')

/**
 * 缓存键带上文件大小和修改时间：同一路径的文件换了内容（粘贴路径引用的本机文件可能被覆盖）要重新生成。
 * 只按文件内容算会让每次请求都先读一遍原图，失去缩略图的意义。
 */
const keyOf = (file: string, s: { size: number; mtimeMs: number }, width: number) =>
  createHash('sha1').update(`${file}\n${s.size}\n${s.mtimeMs}\n${width}`).digest('hex')

/** 同一张图同时被请求（同一段消息渲染两遍、气泡和浮层一起打开）时只算一次 */
const inflight = new Map<string, Promise<Buffer | null>>()

/** 解码缩放是同步计算：串起来一张一张做，免得一堆缩略图请求同时把服务端卡住 */
let queue: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

/** 缩略图；生成不了（格式不支持、比目标还小、太大、读不到文件）时返回 null */
export async function thumbnail(file: string, width: number): Promise<Buffer | null> {
  const w = Math.round(Math.min(Math.max(width, 1), MAX_THUMB_WIDTH))
  const s = await stat(file).catch(() => null)
  if (!s?.isFile()) return null
  const key = keyOf(file, s, w)
  // 检查和登记之间不能有 await：两个请求同时到达时，后一个要拿到前一个的 job 而不是再算一遍
  const running = inflight.get(key)
  if (running) return running
  const job = serialize(async () => {
    const hit = await readFile(path.join(DIR(), key)).catch(() => null)
    return hit ?? build(file, w, key)
  }).finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

async function build(file: string, width: number, key: string): Promise<Buffer | null> {
  const buf = await readFile(file).catch(() => null)
  if (!buf) return null
  // 先看文件头：比目标还小的不用缩（缩了反而糊），超大图不解码
  const size = pngSize(buf)
  if (!size || size.width <= width || size.width * size.height > MAX_THUMB_PIXELS) return null
  const img = decodePng(buf)
  if (!img) return null
  const out = encodePng(resize(img, width, Math.round((img.height * width) / img.width)))
  const target = path.join(DIR(), key)
  // 先写临时文件再改名：另一个请求正好在写的时候不能读到半张图（读到会被当成坏图、还缓存一天）
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`
  await mkdir(DIR(), { recursive: true })
  try {
    await writeFile(tmp, out)
    await rename(tmp, target)
  } catch {
    // 写不进缓存就用刚算出来的这份，下次再算；临时文件不要留在磁盘上
    await rm(tmp, { force: true }).catch(() => {})
  }
  return out
}

/** 只读 PNG 头里的宽高（IHDR）：解码前就要知道大小 */
function pngSize(buf: Buffer) {
  // 8 字节签名 + 4 字节块长度 + 4 字节类型 'IHDR' + 宽 4 字节 + 高 4 字节
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
