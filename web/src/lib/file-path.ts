/**
 * 消息里「看起来是文件路径」的行内代码：认出它、标成能点的，点开看文件内容或直接看图。
 *
 * 认得太松会把 console.log、1.2.3、https://… 变成点了报错的假链接；认得太紧中文文件名又不认
 * （`ui-shots/107-对话-图片气泡.png` 就是这样点不开的）。所以按「段」校验：
 * 段里的字符用 Unicode 字母数字（含中文），最后一段的扩展名必须像扩展名。
 */
import { baseName, fileKind, nameParts, parentName } from './file-ref'

/** 服务端能按原图返回的图片格式（server/uploads.ts 的 IMAGE_TYPES）：点开直接看大图 */
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
/**
 * 没有目录的纯文件名（`截图.png`、`a.ts`）只有这些扩展名才算路径，否则 `a.b`、`console.log`、`1.2.3`
 * 都会被认成文件。日志、表格这类（.log、.csv）只在带目录时认（`logs/运行时.log`），纯名字太像代码。
 */
const EXT = new Set(
  (
    'ts tsx js jsx mjs cjs json jsonc md mdx css scss less html vue svelte ' +
    'py go rs java kt swift c h cc cpp hpp cs rb php yml yaml toml ini sql sh ps1 bat cmd ' +
    'txt xml gradle dart lua proto graphql ' +
    'png jpg jpeg gif webp bmp svg ico avif pdf ' +
    'xlsx xls xlsm csv docx doc pptx ppt'
  ).split(' '),
)
/** 一个路径段：Unicode 字母数字加常见符号，空格只能夹在中间（`我的 文件.png`） */
const SEG = /^[\p{L}\p{N}_@.#+\-~()[\]& ]+$/u
// 末尾的 :行号 或 :行号:列号
const LINE = /:(\d+)(?::\d+)?$/
// 开头的 ./ ../ ~/ 盘符或根目录只是位置，不参与判断
const LEAD = /^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|~[\\/]|[\\/])+/

/** 最后一段的扩展名：字母开头的 1~8 位小写；`1.2.3`、`a.b` 这种伪扩展名返回空 */
function extOf(path: string) {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  const ext = name.slice(dot + 1).toLowerCase()
  return /^[a-z][a-z0-9]{0,7}$/.test(ext) ? ext : ''
}

/** 是不是图片：点开时按原图看，不在弹窗里当文本显示 */
export const isImagePath = (path: string) => IMAGE.has(extOf(path))

/**
 * 看起来像文件路径的行内代码：带目录的（src/a.ts、./x/y.json），或者常见代码文件的扩展名；
 * 后面可以跟 :行号 或 :行号:列号。不是路径时返回 null
 */
export function parsePath(s: string): { path: string; line?: number } | null {
  let raw = s.trim()
  if (!raw) return null
  // 网址、协议地址（http://、vscode://、//host/www.x）都不是文件
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(raw) || /^www\./i.test(raw)) return null
  let line: number | undefined
  const at = LINE.exec(raw)
  if (at) {
    line = Number(at[1])
    raw = raw.slice(0, at.index)
  }
  // 盘符、根目录、~/ 开头的算绝对路径：第一段可以带空格（C:/Program Files/a.txt）
  const absolute = /^(?:[A-Za-z]:[\\/]|[\\/~])/.test(raw)
  const body = raw.replace(LEAD, '')
  if (!body) return null
  const segs = body.split(/[\\/]/)
  for (const [i, seg] of segs.entries()) {
    if (!seg || !SEG.test(seg)) return null
    // 空格只允许出现在有目录、且不是第一段的位置：
    // 「node scripts/e2e.mjs」这种命令加参数，第一段里就带空格，而目录名很少这样写
    if (seg.includes(' ') && !(segs.length > 1 && (i > 0 || absolute))) return null
  }
  const ext = extOf(body)
  if (!ext) return null
  if (segs.length === 1 && !EXT.has(ext)) return null
  return { path: raw, line }
}

const unescapeHtml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    return e === 'quot' ? '"' : "'"
  })

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 一个文件标记的 HTML：图标（CSS 按 data-kind 画）+ 文件名 + 灰色扩展名 + 行号。
 * label 是 Markdown 链接的文字（[配置](src/a.ts)），有它就显示它；parent 是重名时补在前面的上一级目录。
 * 文字整个包在 .fr-text 里：外层是 inline-flex，名字、扩展名、行号要是各自当一个弹性子项，
 * 窄处（表格列、窄面板）会各自在自己那一列里折行，排成「名字两行 / .l ua / :42 19」三列（用户截图报过）
 */
export function fileRefHtml(p: { path: string; line?: number }, opts: { label?: string; parent?: string } = {}) {
  const line = p.line ? ` data-md-line="${p.line}"` : ''
  const { stem, ext } = nameParts(p.path)
  const body = opts.label
    ? `<span class="fr-name">${opts.label}</span>`
    : (opts.parent ? `<span class="fr-dim">${esc(opts.parent)}/</span>` : '') +
      `<span class="fr-name">${esc(stem)}</span>` +
      (ext ? `<span class="fr-ext">${esc(ext)}</span>` : '')
  return (
    `<span class="md-path file-ref" role="button" tabindex="0" data-file-ref data-kind="${fileKind(p.path)}" ` +
    `data-path="${attr(p.path)}"${line}><span class="fr-text">${body}${p.line ? `<span class="fr-line">:${p.line}</span>` : ''}</span></span>`
  )
}

/** Markdown 链接的地址指向本机文件（没有协议，或 file://）：取出路径；网页链接、锚点返回 null */
function linkTarget(href: string) {
  let h = unescapeHtml(href).trim()
  if (/^file:\/\//i.test(h)) h = decodeURIComponent(h.replace(/^file:\/\/\/?/i, '')).replace(/^(?=[A-Za-z]:)/, '')
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !/^[A-Za-z]:[\\/]/.test(h)) return null
  if (h.startsWith('#')) return null
  try {
    h = decodeURIComponent(h)
  } catch {
    // 地址里有单独的 % 就按原样用
  }
  return parsePath(h)
}

const CODE_OR_LINK = /(<pre\b[\s\S]*?<\/pre>)|<code>([^<\n]+)<\/code>|<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g

/**
 * 渲染好的 Markdown 里，把像路径的行内代码（不在代码块里的）和指向本机文件的链接换成文件标记。
 * 同一条消息里文件名相同、路径不同的，名字前面补上一级目录区分
 */
export function linkPaths(html: string) {
  const found: { path: string; line?: number }[] = []
  const pick = (code?: string, href?: string) =>
    code !== undefined ? parsePath(unescapeHtml(code)) : href !== undefined ? linkTarget(href) : null
  for (const m of html.matchAll(CODE_OR_LINK)) {
    const p = m[1] ? null : pick(m[2], m[3])
    if (p) found.push(p)
  }
  // 同名不同路径：按「名字 → 路径集合」数一遍
  const byName = new Map<string, Set<string>>()
  for (const p of found) {
    const k = baseName(p.path).toLowerCase()
    byName.set(k, (byName.get(k) ?? new Set()).add(p.path.replace(/\\/g, '/')))
  }
  return html.replace(CODE_OR_LINK, (all, pre: string | undefined, code?: string, href?: string, text?: string) => {
    if (pre) return all
    const p = pick(code, href)
    if (!p) return all
    const dup = (byName.get(baseName(p.path).toLowerCase())?.size ?? 0) > 1
    const label = href !== undefined && text && unescapeHtml(text.replace(/<[^>]+>/g, '')).trim() !== p.path ? text : ''
    return fileRefHtml(p, { label, parent: dup && !label ? parentName(p.path) : '' })
  })
}
