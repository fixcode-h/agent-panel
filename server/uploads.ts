import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/schema.ts'
import { capture } from './exec/process.ts'
import { pickFiles } from './pick-file.ts'
import { DATA_DIR } from './store.ts'
import { relativeAttachName } from './attachments.ts'
import { resolvePath } from './fs.ts'
import { openWithSystem, revealItem } from './open.ts'
import { locateFiles } from './locate-file.ts'
import { thumbnail } from './thumbnail.ts'
import { t } from '../shared/i18n.ts'
import { clip } from '../shared/text.ts'

/** 用户上传的附件放在数据目录里，不放进项目目录，免得算进任务的文件改动 */
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')

const UploadInput = z.object({
  name: z.string().trim().min(1).max(200),
  mime: z.string().max(200).default(''),
  /** 文件内容，base64；写请求只收 JSON，所以不用 multipart */
  data: z.string().min(1),
})

/** 文件名里去掉路径和系统不允许的字符 */
const safeName = (n: string) => path.basename(n).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'file'

/** dirs：找大文件原路径时额外翻的目录（各个项目的目录） */
export function uploadsApi(opts: { dirs?: () => Promise<string[]> } = {}) {
  const routes = new Hono()
  routes.post('/', async (c) => {
    const p = UploadInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('上传的内容不对') }, 400)
    const buf = Buffer.from(p.data.data, 'base64')
    if (buf.length > MAX_ATTACHMENT_BYTES)
      return c.json(
        { error: t('「{name}」超过 {size} MB', { name: p.data.name, size: MAX_ATTACHMENT_BYTES / 1024 / 1024 }) },
        400,
      )
    // 每个文件单独一个目录，保留原文件名，Agent 看到的名字和用户选的一样
    const dir = path.join(UPLOADS_DIR, randomUUID())
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, safeName(p.data.name))
    await writeFile(file, buf)
    return c.json({ name: p.data.name, path: file, size: buf.length, mime: p.data.mime } satisfies Attachment, 201)
  })
  /**
   * 在面板所在的本机弹文件选择框，直接拿绝对路径。
   * 浏览器只能给出文件名，大文件（超过上限）要「只引用原路径」就靠这个入口。
   */
  routes.post('/pick', async (c) => {
    try {
      const picked = await pickFiles()
      const files: Attachment[] = []
      for (const file of picked) {
        const s = await stat(file).catch(() => null)
        if (!s?.isFile()) continue
        files.push({
          name: path.basename(file),
          path: file,
          size: s.size,
          mime: mimeOf(file),
        })
      }
      return c.json({ files })
    } catch (e) {
      return c.json({ error: t('打不开选择文件的窗口：{error}', { error: (e as Error).message }) }, 400)
    }
  })
  /**
   * 粘贴进输入框的路径：确认哪些是本机真实存在的文件，交回附件信息（只引用，不拷贝）。
   * 引用卡片存下的原文文件（quote-<编号>.md）认回成引用，带上原文
   */
  routes.post('/resolve', async (c) => {
    const p = z
      .object({ paths: z.array(z.string().min(1).max(4096)).max(50) })
      .safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('上传的内容不对') }, 400)
    const files: (Attachment & { from: string })[] = []
    for (const from of p.data.paths) {
      const file = resolvePath(from)
      const s = await stat(file).catch(() => null)
      if (!s?.isFile()) continue
      const base = path.basename(file)
      const quote = file.startsWith(UPLOADS_DIR + path.sep) ? QUOTE_FILE.exec(base) : null
      if (quote && s.size <= 200_000) {
        const text = await readFile(file, 'utf8').catch(() => null)
        if (text !== null) {
          files.push({
            from,
            name: quoteName(text, quote[1]),
            path: file,
            size: s.size,
            mime: 'text/markdown',
            quote: text,
            ref: true,
          })
          continue
        }
      }
      files.push({ from, name: base, path: file, size: s.size, mime: mimeOf(file), ref: true })
    }
    return c.json({ files })
  })
  /**
   * 粘贴、拖进来的大文件（超过上限，不上传）：浏览器给不出路径，按名字、大小、修改时间在本机找回原文件，
   * 只引用不拷贝（见 locate-file.ts）。找不到的不在结果里，index 对应请求里的第几个
   */
  routes.post('/locate', async (c) => {
    const p = z
      .object({
        files: z
          .array(
            z.object({ name: z.string().min(1).max(260), size: z.number().int().min(0), mtime: z.number().optional() }),
          )
          .min(1)
          .max(MAX_ATTACHMENTS),
      })
      .safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('上传的内容不对') }, 400)
    const dirs = (await opts.dirs?.().catch(() => [])) ?? []
    const found = await locateFiles(p.data.files, dirs)
    const files = p.data.files.flatMap((w, index) => {
      const file = found.get(w)
      return file ? [{ index, name: w.name, path: file, size: w.size, mime: mimeOf(file), ref: true }] : []
    })
    return c.json({ files })
  })
  /** 点开附件卡片后：用系统默认程序打开，或在文件管理器里显示（可执行文件只显示，不运行） */
  routes.post('/open', async (c) => {
    const p = z
      .object({ path: z.string().min(1).max(4096), reveal: z.boolean().default(false) })
      .safeParse(await c.req.json().catch(() => null))
    if (!p.success || !path.isAbsolute(p.data.path)) return c.json({ error: t('不是附件') }, 400)
    const file = path.resolve(p.data.path)
    if (!(await stat(file).catch(() => null))) return c.json({ error: t('附件已经不在了') }, 404)
    if (p.data.reveal) {
      try {
        await revealItem(file)
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400)
      }
      return c.json({ ok: true, revealed: true })
    }
    try {
      if (await openWithSystem(file)) return c.json({ ok: true, revealed: false })
      await revealItem(file)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    return c.json({ ok: true, revealed: true })
  })
  return routes
}

/** 引用卡片的原文存成的文件名：quote-<编号>.md，编号和卡片名字末尾的「#编号」一样 */
const QUOTE_FILE = /^quote-(q[0-9a-z]+)\.md$/

/** 引用卡片的名字：开头一小段摘要加编号（和网页 web/src/lib/quote.ts 的 quoteName 一致） */
function quoteName(text: string, id: string) {
  const flat = text.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${flat.length > 40 ? `${flat.slice(0, 40)}…` : flat}#${id}`
}

/** 看文件时最多读这么多（和查看项目文件一样） */
const MAX_VIEW = 400_000

const mimeOf = (file: string) => IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()] ?? ''

/** 面板自己生成的附件（例如引入的会话记录）：和上传的一样存进附件目录 */
export async function saveTextUpload(name: string, text: string): Promise<Attachment> {
  const dir = path.join(UPLOADS_DIR, randomUUID())
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, safeName(name))
  const buf = Buffer.from(text, 'utf8')
  await writeFile(file, buf)
  return { name, path: file, size: buf.length, mime: 'text/markdown' }
}

/** 引入的会话记录最多这么多字：太长的只留开头和最近的部分 */
const MAX_TRANSCRIPT = 120_000
export const clipTranscript = (s: string) =>
  clip(s, MAX_TRANSCRIPT, { tailRatio: 0.3, mark: (omitted) => `\n\n…（中间省略 ${omitted} 字）…\n\n` })

/**
 * 给页面看附件：raw 读原图（缩略图、看大图），file 读文字内容（点文件卡片时看）。
 * 附件目录里的文件都能读；粘贴路径引用的本机文件在附件目录外面，只有绝对路径才读，raw 只给图片。
 * 消息里存成 `attachments/名字`（当时拷进任务目录的那份）的旧附件按文件名回附件目录找：
 * 任务目录会跟着独立分支删掉，上传目录里的那份是同一份内容。
 */
export function uploadsRawApi() {
  /** 解析不出来时给的原因：名字对得上但文件已经没了按「附件已经不在了」，其他都算「不是附件」 */
  const whyNotFound = (want: string) =>
    !path.isAbsolute(want) && !!relativeAttachName(want)
      ? ({ error: t('附件已经不在了') } as const)
      : ({ error: t('不是附件') } as const)
  const statusOf = (want: string) => (path.isAbsolute(want) || !relativeAttachName(want) ? 400 : 404)
  const routes = new Hono()
  routes.get('/', async (c) => {
    const want = (c.req.query('path') ?? '').trim()
    const file = await resolveAttachment(want)
    if (!file) return c.json(whyNotFound(want), statusOf(want))
    const ext = path.extname(file).slice(1).toLowerCase()
    const inUploads = file.startsWith(UPLOADS_DIR + path.sep)
    if (!inUploads && !IMAGE_TYPES[ext]) return c.json({ error: t('不是图片') }, 400)
    // w：要缩略图（消息里的卡片只占一行字的高度，没必要取原图）；生成不了时退回原图
    const width = Number(c.req.query('w') ?? '')
    if (width > 0) {
      const thumb = await thumbnail(file, width)
      // 转成 Uint8Array 再交给 c.body：Node 的 Buffer 泛型是 ArrayBufferLike，hono 只接 Uint8Array<ArrayBuffer>
      if (thumb)
        return c.body(new Uint8Array(thumb), 200, { 'Content-Type': 'image/png', 'Cache-Control': THUMB_CACHE })
    }
    const buf = await readFile(file).catch(() => null)
    if (!buf) return c.json({ error: t('附件已经不在了') }, 404)
    const type = IMAGE_TYPES[ext] ?? 'application/octet-stream'
    return c.body(buf, 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' })
  })
  routes.get('/file', async (c) => {
    const want = (c.req.query('path') ?? '').trim()
    const file = await resolveAttachment(want)
    if (!file) return c.json(whyNotFound(want), statusOf(want))
    const dir = path.dirname(file)
    const s = await stat(file).catch(() => null)
    if (!s?.isFile()) return c.json({ path: file, dir, exists: false, content: '', truncated: false })
    const buf = await readFile(file)
    const head = buf.subarray(0, MAX_VIEW)
    if (head.includes(0)) return c.json({ path: file, dir, exists: true, binary: true, content: '', truncated: false })
    return c.json({ path: file, dir, exists: true, content: head.toString('utf8'), truncated: buf.length > MAX_VIEW })
  })
  return routes
}

/** 缩略图是生成的、文件不会原地改（同一个文件同宽度只算一次），缓存一天和原图一致 */
const THUMB_CACHE = 'private, max-age=86400'

export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/**
 * 把页面给的附件地址解析成能读的绝对路径；不是附件时返回空。
 * 绝对路径照旧（附件目录里的、粘贴路径引用的本机文件）；
 * `attachments/名字` 这种相对路径只在附件目录里按文件名找，不接受 `..`、多级目录和别的写法，防止拿它读任意文件。
 */
async function resolveAttachment(want: string): Promise<string> {
  const p = want.trim()
  if (!p) return ''
  if (path.isAbsolute(p)) return path.resolve(p)
  const name = relativeAttachName(p)
  if (!name) return ''
  const dirs = await readdir(UPLOADS_DIR).catch(() => [])
  // 每个附件单独一个目录：名字一样时取第一个能找到的（截图的名字里带时间，基本不会重）
  const found = await Promise.all(
    dirs.map(async (d) => {
      const full = path.join(UPLOADS_DIR, d, name)
      return (await stat(full).catch(() => null))?.isFile() ? full : ''
    }),
  )
  return found.find(Boolean) ?? ''
}

/** 附件所在的目录（每个附件单独一个目录）；不是附件时返回空 */
export function uploadDirOf(file: string) {
  const full = path.resolve(file)
  if (!full.startsWith(UPLOADS_DIR + path.sep)) return ''
  return path.join(UPLOADS_DIR, full.slice(UPLOADS_DIR.length + 1).split(path.sep)[0])
}

/**
 * 清理没有任务在用的附件。不按时间删：老任务还在时它的截图、文件也要留着，继续执行时 Agent 还要读。
 * 刚上传、还没发出去的附件也没有任务引用，所以只删一天以前的。
 * keepNames：消息里只存了 `attachments/名字` 的旧附件，按文件名保住上传目录里的那一份，否则这些旧消息的图会被清掉。
 */
export async function cleanupUploads(
  referenced: Set<string>,
  opts: { graceMs?: number; keepNames?: Set<string> } = {},
) {
  const dirs = await readdir(UPLOADS_DIR).catch(() => [])
  const cutoff = Date.now() - (opts.graceMs ?? 86_400_000)
  const keep = opts.keepNames
  for (const d of dirs) {
    const full = path.join(UPLOADS_DIR, d)
    if (referenced.has(full)) continue
    if (keep?.size) {
      const names = await readdir(full).catch(() => [])
      if (names.some((n) => keep.has(n))) continue
    }
    const s = await stat(full).catch(() => null)
    if (s && s.mtimeMs < cutoff) await rm(full, { recursive: true, force: true }).catch(() => {})
  }
}

/** 删掉这些附件目录（删除任务时用；调用方保证别的任务没在用） */
export async function removeUploads(dirs: Iterable<string>) {
  for (const d of dirs) if (d) await rm(d, { recursive: true, force: true }).catch(() => {})
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'Binaries', 'Intermediate'])
const MAX_FILES = 20_000

/** 项目里的文件（相对路径）：git 仓库用 ls-files，尊重 .gitignore；不是仓库时自己遍历，跳过常见的产物目录 */
async function projectFiles(root: string): Promise<string[]> {
  const r = await capture(
    'git',
    ['-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard'],
    root,
    undefined,
    15_000,
  ).catch(() => null)
  if (r?.code === 0) return r.stdout.split('\n').filter(Boolean).slice(0, MAX_FILES)
  const out: string[] = []
  const walk = async (dir: string, rel: string) => {
    if (out.length >= MAX_FILES) return
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const it of items) {
      if (out.length >= MAX_FILES) return
      if (it.name.startsWith('.') && it.name !== '.github') continue
      const r = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) {
        if (!SKIP.has(it.name)) await walk(path.join(dir, it.name), r)
      } else out.push(r)
    }
  }
  await walk(root, '')
  return out
}

const cache = new Map<string, { at: number; files: string[] }>()

/**
 * 输入 @ 时按关键字找项目文件：文件名命中排在路径命中前面，短路径优先。
 * 结果缓存一小会儿，连续输入不用每次都重新列。
 */
export async function searchProjectFiles(dir: string, q: string, limit = 30) {
  const root = resolvePath(dir)
  let hit = cache.get(root)
  if (!hit || Date.now() - hit.at > 10_000) {
    hit = { at: Date.now(), files: await projectFiles(root) }
    cache.set(root, hit)
  }
  const query = q.trim().toLowerCase().replace(/\\/g, '/')
  if (!query) return hit.files.slice(0, limit)
  const scored: { f: string; s: number }[] = []
  for (const f of hit.files) {
    const low = f.toLowerCase()
    const base = low.slice(low.lastIndexOf('/') + 1)
    const s = base.startsWith(query) ? 0 : base.includes(query) ? 1 : low.includes(query) ? 2 : -1
    if (s >= 0) scored.push({ f, s })
  }
  scored.sort((a, b) => a.s - b.s || a.f.length - b.f.length)
  return scored.slice(0, limit).map((x) => x.f)
}
