import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/schema.ts'
import { capture } from './exec/process.ts'
import { DATA_DIR } from './store.ts'
import { resolvePath } from './fs.ts'
import { t } from '../shared/i18n.ts'

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

export function uploadsApi() {
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
  return routes
}

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
  s.length > MAX_TRANSCRIPT
    ? `${s.slice(0, MAX_TRANSCRIPT * 0.3)}\n\n…（中间省略 ${s.length - MAX_TRANSCRIPT} 字）…\n\n${s.slice(-MAX_TRANSCRIPT * 0.7)}`
    : s

/** 只读出附件目录里的文件，给页面显示缩略图；不能用来读任意路径 */
export function uploadsRawApi() {
  const routes = new Hono()
  routes.get('/', async (c) => {
    const file = path.resolve(c.req.query('path') ?? '')
    if (!file.startsWith(UPLOADS_DIR + path.sep)) return c.json({ error: t('不是附件') }, 400)
    const buf = await readFile(file).catch(() => null)
    if (!buf) return c.json({ error: t('附件已经不在了') }, 404)
    const ext = path.extname(file).slice(1).toLowerCase()
    const type = IMAGE_TYPES[ext] ?? 'application/octet-stream'
    return c.body(buf, 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' })
  })
  return routes
}
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
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
 */
export async function cleanupUploads(referenced: Set<string>, graceMs = 86_400_000) {
  const dirs = await readdir(UPLOADS_DIR).catch(() => [])
  const cutoff = Date.now() - graceMs
  for (const d of dirs) {
    const full = path.join(UPLOADS_DIR, d)
    if (referenced.has(full)) continue
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
