/**
 * 沙箱源：网页页签里看本机 HTML 走这里（设计稿第 6 节，ADR 0068）。
 *
 * 面板自己全站回 X-Frame-Options: DENY（防点击劫持，见 http-guards.ts），本机文件不能直接嵌。
 * 这里按短时令牌发文件：令牌只认发它时定下的那个根目录（对话目录 / 项目目录 / 插件目录），
 * 地址是 /sandbox/f/<令牌>/<相对根目录的路径>，页面里 ./style.css、../img/a.png 这类相对引用照常能取到。
 * 响应带 CSP sandbox（不给 allow-same-origin）：页面跑在不透明源里，读不到面板的 Cookie、调不了面板接口。
 *
 * 挂在主端口、排在令牌检查前面：沙箱页面是不透明源，浏览器不给它带面板的 Cookie，
 * 走令牌检查的话开了访问令牌后页面里的图片、脚本一律 401；这里的令牌本身就是凭据（32 字节随机数）。
 */
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'hono'
import { t } from '../../shared/i18n.ts'
import { withPanelScrollbar } from '../../shared/web-view/scrollbar.ts'

export const SANDBOX_PREFIX = '/sandbox/f/'

/** 令牌多久过期：页签开着一下午也还能刷新；过期后页面重新取一次地址 */
const TOKEN_TTL = 6 * 60 * 60_000
/** 单个文件最大多少：再大的多半不是给人看的网页 */
const MAX_FILE = 64 * 1024 * 1024

/** 沙箱页面能做什么：能跑脚本、弹新窗口、下载、提交表单、弹 alert；不给同源（读不到面板） */
export const SANDBOX_CSP =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms allow-modals; frame-ancestors 'self'"

interface Grant {
  root: string
  expires: number
}

// 模块状态：运行时，令牌 → 根目录。面板重启后全部作废，页签里的页面重新取地址就行
const grants = new Map<string, Grant>()

/** 给一个根目录发令牌：同一个根目录还没过期的直接复用，同一页里多个文件共用一个令牌 */
export function grantRoot(root: string, now = Date.now()) {
  for (const [k, g] of grants) if (g.expires <= now) grants.delete(k)
  for (const [k, g] of grants) if (g.root === root && g.expires - now > TOKEN_TTL / 2) return k
  const token = randomBytes(32).toString('base64url')
  grants.set(token, { root, expires: now + TOKEN_TTL })
  return token
}

/** 沙箱地址：路径每段分别编码，斜杠留着（相对引用要按目录解析） */
export function sandboxUrl(token: string, rel: string) {
  return `${SANDBOX_PREFIX}${token}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
}

export const sandboxType = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/** 真实路径在不在根目录里（符号链接指到外面的也不行） */
export function inside(root: string, full: string) {
  const rel = path.relative(root, full)
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** GET /sandbox/f/<令牌>/<路径> */
export async function serveSandbox(c: Context) {
  const rest = c.req.path.slice(SANDBOX_PREFIX.length)
  const cut = rest.indexOf('/')
  const token = cut < 0 ? rest : rest.slice(0, cut)
  const g = grants.get(token)
  if (!g || g.expires <= Date.now()) return c.text(t('地址已过期，请在页签里刷新'), 404)
  let rel: string
  try {
    rel = decodeURIComponent(cut < 0 ? '' : rest.slice(cut + 1))
  } catch {
    return c.text(t('地址不对'), 400)
  }
  const want = path.resolve(g.root, rel)
  const full = await realpath(want).catch(() => '')
  const root = await realpath(g.root).catch(() => g.root)
  if (!full || !inside(root, full)) return c.text(t('文件不存在'), 404)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) return c.text(t('文件不存在'), 404)
  if (info.size > MAX_FILE) return c.text(t('文件太大，超过 {mb} MB', { mb: MAX_FILE / 1024 / 1024 }), 413)
  const buf = await readFile(full)
  const type = sandboxType(full)
  // HTML 页面插一段全站同款的滚动条样式（iframe 里管不到，见 shared/web-view/scrollbar.ts）
  const body = type.startsWith('text/html') ? new TextEncoder().encode(withPanelScrollbar(buf.toString('utf8'))) : buf
  return c.body(new Uint8Array(body), 200, {
    'Content-Type': type,
    // 改了文件刷新就要看到新的
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
}
