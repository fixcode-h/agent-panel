/**
 * 对话里的「文件标记」：图标 + 文件名 + 灰色扩展名（带行号时跟 :行号），目录放到悬停卡片上。
 * 回复正文（Markdown 渲染出的 HTML 字符串）、工具行和用户消息里的附件共用这里的判断，长得一样、点了行为一样。
 */
import { isImagePath } from './file-path'

/** 图标种类：CSS 按 data-kind 画（index.css 的 .file-ref），React 里的标记也用同一个值 */
export type FileKind = 'code' | 'data' | 'text' | 'image' | 'sheet' | 'doc' | 'media' | 'archive' | 'folder' | 'file'

const KINDS: [FileKind, RegExp][] = [
  ['image', /^(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|heic|avif|psd)$/],
  ['sheet', /^(xlsx?|xlsm|ods|csv|tsv|numbers)$/],
  ['doc', /^(docx?|pdf|pptx?|odt|odp|rtf|key|pages)$/],
  ['data', /^(json|jsonc|ya?ml|toml|ini|xml|lock|env|cfg|conf|proto|graphql)$/],
  ['text', /^(md|mdx|txt|rst|log|markdown)$/],
  ['media', /^(mp3|wav|ogg|flac|m4a|aac|mp4|mov|m4v|webm|mkv|avi)$/],
  ['archive', /^(zip|7z|rar|tar|gz|tgz|bz2|xz)$/],
  [
    'code',
    /^(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|swift|c|h|cc|cpp|cxx|hpp|hh|cs|rb|php|lua|sh|bash|ps1|bat|cmd|html?|css|scss|less|sql|dart|gradle|cmake)$/,
  ],
]

/** 扩展名（小写，不含点）；没有扩展名时为空 */
export function extOf(path: string) {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 路径的最后一段：结尾的分隔符先去掉（`src/` 的名字是 src） */
export function baseName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

/** 上一级目录的名字：同一条消息里有重名文件时补在前面区分 */
export function parentName(path: string) {
  const segs = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return segs.length > 1 ? segs[segs.length - 2] : ''
}

export function fileKind(path: string, dir = false): FileKind {
  if (dir || /[\\/]$/.test(path)) return 'folder'
  const ext = extOf(path)
  return KINDS.find(([, re]) => re.test(ext))?.[0] ?? 'file'
}

/**
 * 面板自己能预览的文字类型：单击在面板里看（用户 2026-11-05 定的：md、cpp 这类面板能看的就在面板里打开），
 * 其余（xlsx、docx、pdf……）交给系统默认程序。只按扩展名判断，点之前就知道去哪，不用先请求一次
 */
const TEXT = new Set(
  (
    'ts tsx js jsx mjs cjs vue svelte py go rs java kt kts swift c h cc cpp cxx hpp hh inl cs rb php lua sh bash zsh ' +
    'ps1 psm1 bat cmd html htm css scss less sql dart gradle cmake proto graphql ' +
    'json jsonc json5 yaml yml toml ini cfg conf env xml plist csv tsv lock ' +
    'md mdx markdown txt rst log diff patch gitignore editorconfig'
  ).split(' '),
)

/** 单击做什么：图片看大图、文字在面板里看，别的交给系统（目录在文件管理器里打开） */
export function clickAction(path: string, dir = false): 'image' | 'text' | 'system' {
  if (dir) return 'system'
  if (isImagePath(path)) return 'image'
  return TEXT.has(extOf(path)) ? 'text' : 'system'
}

/** 文件名拆成主名和「.扩展名」两段显示：扩展名灰一点；复制选中文字时两段连起来还是完整文件名 */
export function nameParts(path: string) {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

/** 文件大小：悬停卡片里用 */
export function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}
