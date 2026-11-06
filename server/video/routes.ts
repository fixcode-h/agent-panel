/**
 * 视频截帧的接口（挂在 /video）：FFmpeg 状态和下载、打开视频、播放、截帧、自动截帧、增强。
 * 都在本机跑；视频只读，见 server/video/frames.ts。
 */
import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { t } from '../../shared/i18n.ts'
import { AUTO_MODES, type AutoMode } from '../../shared/video.ts'
import { cancelFfmpegDownload, downloadFfmpeg, ffmpegStatus, setFfmpegPath } from './ffmpeg.ts'
import {
  autoFrames,
  autoProgressOf,
  clearEnhanced,
  enhanceFrames,
  enhanceMethods,
  manualFrame,
  openVideo,
  previewAt,
  removeFrames,
  streamable,
} from './frames.ts'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
}

type Body = { key?: string; path?: string; time?: number; mode?: string; count?: number; ids?: string[] }

export function videoApi() {
  const r = new Hono()
  const fail = (e: unknown) => ({ error: (e as Error).message })
  const body = async (c: { req: { json: () => Promise<unknown> } }) =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Body

  r.get('/status', async (c) => c.json(await ffmpegStatus()))
  r.post('/ffmpeg/download', async (c) => {
    const { mirror } = (await c.req.json().catch(() => ({}))) as { mirror?: boolean }
    try {
      downloadFfmpeg(!!mirror)
    } catch (e) {
      return c.json(fail(e), 400)
    }
    return c.json(await ffmpegStatus())
  })
  r.post('/ffmpeg/cancel', async (c) => {
    cancelFfmpegDownload()
    return c.json(await ffmpegStatus())
  })
  r.put('/ffmpeg/path', async (c) => {
    const { path: p } = (await c.req.json().catch(() => ({}))) as { path?: string }
    await setFfmpegPath(String(p ?? ''))
    const s = await ffmpegStatus()
    if (p?.trim() && s.path !== p.trim())
      return c.json({ error: t('这个路径的 ffmpeg 运行不起来：{path}', { path: p }) }, 400)
    return c.json(s)
  })

  r.post('/open', async (c) => {
    const b = await body(c)
    try {
      return c.json(await openVideo(String(b.path ?? '')))
    } catch (e) {
      return c.json(fail(e), 400)
    }
  })

  // 播放：支持 Range（浏览器拖进度条时按段取），只放行视频文件
  r.get('/stream', async (c) => {
    let file: { full: string; size: number }
    try {
      file = await streamable(c.req.query('path') ?? '')
    } catch (e) {
      return c.json(fail(e), 404)
    }
    const type = MIME[path.extname(file.full).toLowerCase()] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(c.req.header('range') ?? '')
    if (!range || !file.size) {
      const stream = Readable.toWeb(createReadStream(file.full)) as ReadableStream
      return c.body(stream, 200, {
        'Content-Type': type,
        'Content-Length': String(file.size),
        'Accept-Ranges': 'bytes',
      })
    }
    let start = range[1] ? Number(range[1]) : file.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : file.size - 1
    start = Math.max(0, Math.min(start, file.size - 1))
    end = Math.min(Math.max(end, start), file.size - 1)
    const stream = Readable.toWeb(createReadStream(file.full, { start, end })) as ReadableStream
    return c.body(stream, 206, {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
      'Accept-Ranges': 'bytes',
    })
  })

  r.get('/preview', async (c) => {
    try {
      const jpg = await previewAt(c.req.query('path') ?? '', Number(c.req.query('t') ?? 0))
      return c.body(new Uint8Array(jpg), 200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      })
    } catch (e) {
      return c.json(fail(e), 400)
    }
  })

  r.post('/frames/manual', async (c) => {
    const b = await body(c)
    try {
      return c.json(await manualFrame(String(b.key), String(b.path ?? ''), Number(b.time ?? 0)))
    } catch (e) {
      return c.json(fail(e), 400)
    }
  })
  r.post('/frames/auto', async (c) => {
    const b = await body(c)
    const mode = (AUTO_MODES as readonly string[]).includes(b.mode ?? '') ? (b.mode as AutoMode) : 'uniform'
    try {
      return c.json(await autoFrames(String(b.key), String(b.path ?? ''), mode, Number(b.count ?? 8), c.req.raw.signal))
    } catch (e) {
      return c.json(fail(e), 400)
    }
  })
  // 自动截帧的进度：弹窗在等结果时轮询（没在截时为 null）
  r.get('/frames/progress', (c) => c.json({ progress: autoProgressOf(c.req.query('key') ?? '') }))
  r.post('/frames/remove', async (c) => {
    const b = (await body(c)) as Body & { which?: string }
    const which = b.which === 'manual' || b.which === 'auto' ? b.which : undefined
    if (!which && !Array.isArray(b.ids)) return c.json({ error: t('没有说要删哪些帧') }, 400)
    try {
      return c.json(await removeFrames(String(b.key), String(b.path ?? ''), { which, ids: b.ids }))
    } catch (e) {
      return c.json(fail(e), 400)
    }
  })

  r.get('/enhance/methods', async (c) => c.json({ methods: await enhanceMethods() }))
  r.post('/frames/enhance', async (c) => {
    const b = (await body(c)) as Body & { method?: string }
    try {
      return c.json(
        await enhanceFrames(String(b.key), String(b.path ?? ''), b.ids ?? [], String(b.method ?? ''), c.req.raw.signal),
      )
    } catch (e) {
      return c.json(fail(e), 400)
    }
  })
  r.post('/frames/unenhance', async (c) => {
    const b = await body(c)
    try {
      return c.json(await clearEnhanced(String(b.key), String(b.path ?? ''), b.ids))
    } catch (e) {
      return c.json(fail(e), 400)
    }
  })
  return r
}
