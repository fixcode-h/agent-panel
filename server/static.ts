/**
 * 生产模式下托管前端构建产物（`dist/`）。
 *
 * 为什么不用 `serveStatic`：它既不压缩也不给缓存头——首屏 2.5MB 未压缩、每次打开都整份重传，
 * 而带内容哈希的 `assets/*` 明明可以一年不再问。这里用 Node 内置的 zlib 做 gzip（压缩结果按文件缓存，
 * 并发请求同一个文件只压一次），再按文件类型给缓存头。只在 `prod` 分支挂上，
 * `npm run dev` 下前端由 Vite 自己服务，完全不经过这里。
 */
import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzip } from 'node:zlib'
import type { Context, MiddlewareHandler } from 'hono'

/** 值得压缩的类型：字体、图片本身已经是压缩格式，再 gzip 只会更大、还白烧 CPU */
const TEXT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

/** 不压缩、只按扩展名给 content-type */
const OTHER_TYPES: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
}

/** `dist/assets/` 下全部是 Vite 生成、文件名带内容哈希的产物：一年内不用再问服务端 */
const ASSETS_PREFIX = '/assets/'
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
/** 入口页和不带哈希的文件（favicon 之类）：每次都校验一次（命中就是 304），发版后立刻拿到新版本 */
const NO_CACHE = 'no-cache'

/** 压缩级别：默认的 6，文本资源的体积和 CPU 的平衡点 */
const GZIP_LEVEL = 6
/** 压缩结果最多缓存这么多个文件（首屏几十个 js/css，够用了） */
const CACHE_MAX = 256

type Cached = { mtimeMs: number; size: number; body: Buffer }
const cache = new Map<string, Cached>()
/** 正在压的同一个文件：几个请求同时到不要各压一遍 */
const pending = new Map<string, Promise<Buffer>>()

/** gzip 的 Promise 包装：promisify 对 zlib 带 options 的重载推不准类型，这里直接包一层 */
const gzipAsync = (data: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    gzip(data, { level: GZIP_LEVEL }, (err, out) => (err ? reject(err) : resolve(out))),
  )

/** 客户端要不要 gzip（`gzip;q=0` 这种明确拒绝的不算） */
export function acceptsGzip(header: string | undefined) {
  if (!header) return false
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';')
    const coding = name.trim().toLowerCase()
    if (coding !== 'gzip' && coding !== '*') return false
    const q = params.map((x) => x.trim().toLowerCase()).find((x) => x.startsWith('q='))
    return !q || Number(q.slice(2)) > 0
  })
}

/** 压缩并按文件缓存：重新构建（mtime / 大小变了）就重压 */
async function compressed(file: string, info: Stats): Promise<Buffer> {
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.body
  const running = pending.get(file)
  if (running) return running
  const job = (async () => {
    const body = await gzipAsync(await readFile(file))
    cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, body })
    // 旧的先丢：构建产物换了名字后老文件不会再被请求，留着只是占内存
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
    return body
  })()
  pending.set(file, job)
  try {
    return await job
  } finally {
    pending.delete(file)
  }
}

/** 请求路径 → 磁盘文件；越界（`..`）或解码不出来返回 null，交给下一步处理 */
function fileOf(root: string, urlPath: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const rel = decoded.replace(/^\/+/, '')
  const file = path.resolve(root, rel || 'index.html')
  // 以目录形式访问（`/assets/`）也先算成 index.html，stat 不是文件就继续往下走
  return file === root || file.startsWith(root + path.sep) ? file : null
}

async function sendFile(c: Context, file: string, info: Stats, urlPath: string) {
  const ext = path.extname(file).toLowerCase()
  const text = TEXT_TYPES[ext]
  const type = text ?? OTHER_TYPES[ext] ?? 'application/octet-stream'
  const useGzip = !!text && acceptsGzip(c.req.header('accept-encoding'))
  // 同一份资源有压缩和未压缩两种内容，ETag 要分开：否则缓存会拿 gzip 的那份去回不要 gzip 的请求
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}${useGzip ? '-gz' : ''}"`
  // 先判 304：内容没变就不读盘、也不压
  if (c.req.header('if-none-match') === etag) return c.body(null, 304)
  const body = useGzip ? await compressed(file, info) : await readFile(file)
  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(body.length),
    etag,
    'cache-control': urlPath.startsWith(ASSETS_PREFIX) ? IMMUTABLE_CACHE : NO_CACHE,
  }
  // 可压缩的类型总是声明 vary：同一 URL 会按 Accept-Encoding 回不同内容，中间缓存不能混用
  if (text) headers.vary = 'accept-encoding'
  if (useGzip) {
    headers['content-encoding'] = 'gzip'
  }
  // HEAD 也要 content-length（压缩后的长度），所以上面照常取内容；压缩结果有缓存，不会重复压
  if (c.req.method === 'HEAD') return c.body(null, 200, headers)
  // Hono 的 body 只接字符串 / ArrayBuffer / Blob / Uint8Array：Buffer 的底层是 ArrayBufferLike，这里转一份
  // （压缩后通常几十到几百 KB，复制一次比强转类型安稳）
  return c.body(new Uint8Array(body), 200, headers)
}

/**
 * 挂在 `/*` 上：命中 `dist/` 里的文件就回，不命中交给后面的 SPA 入口兜底
 */
export function serveDist(dist: string): MiddlewareHandler {
  const root = path.resolve(dist)
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()
    const file = fileOf(root, c.req.path)
    if (!file) return next()
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return next()
    return sendFile(c, file, info, c.req.path)
  }
}

/**
 * SPA 兜底：没匹配到静态文件的 GET 回入口页（前端路由自己处理路径）。
 * 入口页用 `no-cache`：发版后浏览器会重新校验，不会因为长缓存停在旧版本上。
 */
export function serveIndex(dist: string): MiddlewareHandler {
  const file = path.join(path.resolve(dist), 'index.html')
  return async (c) => {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return c.text('前端构建产物不存在，请先运行 npm run build', 404)
    return sendFile(c, file, info, '/index.html')
  }
}
