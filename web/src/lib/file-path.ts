/**
 * 消息里「看起来是文件路径」的行内代码：认出它、标成能点的，点开看文件内容或直接看图。
 *
 * 认得太松会把 console.log、1.2.3、https://… 变成点了报错的假链接；认得太紧中文文件名又不认
 * （`ui-shots/107-对话-图片气泡.png` 就是这样点不开的）。所以按「段」校验：
 * 段里的字符用 Unicode 字母数字（含中文），最后一段的扩展名必须像扩展名。
 */
import { t } from '@shared/i18n'

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
    'png jpg jpeg gif webp bmp svg ico avif pdf'
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

/** 渲染好的 Markdown 里，把像路径的行内代码（不在代码块里的）标成可以点的 */
export function linkPaths(html: string) {
  return html.replace(
    /(<pre\b[\s\S]*?<\/pre>)|<code>([^<\n]+)<\/code>/g,
    (all, pre: string | undefined, text: string) => {
      if (pre) return all
      const p = parsePath(unescapeHtml(text))
      if (!p) return all
      const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      const line = p.line ? ` data-line="${p.line}"` : ''
      const tip = t(isImagePath(p.path) ? '查看图片' : '查看文件')
      return `<code class="md-path" role="button" tabindex="0" data-path="${attr(p.path)}"${line} title="${tip}">${text}</code>`
    },
  )
}
