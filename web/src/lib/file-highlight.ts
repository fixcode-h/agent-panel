import { useEffect, useState } from 'react'
import { ensureHljs } from '@/lib/workflow-doc'

/**
 * 文件弹窗的语法高亮：阅读时按行拆开带行号，编辑时整段铺在输入框下面。
 * highlight.js 体积不小，按需加载（useHljs），没加载完或认不出语言时按纯文本显示。
 */
export type Hljs = Awaited<ReturnType<typeof ensureHljs>>

/** 扩展名 → highlight.js 的语言名；common 包里只带了这些语言，没有的按纯文本显示 */
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
}

/**
 * 高亮后的 HTML 按行拆开：高亮结果里跨行的 <span> 在这一行结尾补上闭合、下一行开头重新打开，
 * 这样每一行仍是独立的元素，行号和 data-line 定位都还用得上，不会变成一整块。
 */
export function splitHtmlLines(html: string) {
  const out: string[] = []
  const open: string[] = []
  let cur = ''
  let i = 0
  while (i < html.length) {
    if (html[i] === '\n') {
      out.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
      i++
    } else if (html[i] === '<') {
      const end = html.indexOf('>', i)
      const tag = html.slice(i, end < 0 ? html.length : end + 1)
      if (/^<span\b/.test(tag)) open.push(tag)
      else if (tag === '</span>') open.pop()
      cur += tag
      i = end < 0 ? html.length : end + 1
    } else {
      // 一整段文字一次拷过去，只有换行需要单独处理
      const next = html.indexOf('<', i)
      const stop = next < 0 ? html.length : next
      const nl = html.indexOf('\n', i)
      if (nl >= 0 && nl < stop) {
        cur += html.slice(i, nl)
        i = nl
      } else {
        cur += html.slice(i, stop)
        i = stop
      }
    }
  }
  out.push(cur)
  return out
}

/** 高亮每一行；语言认不出来时返回 null，调用方按纯文本显示 */
export function highlightLines(hl: Hljs | null, code: string, path: string) {
  if (!hl || !code) return null
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const lang = LANG[ext]
  if (!lang || !hl.getLanguage(lang)) return null
  return splitHtmlLines(hl.highlight(code, { language: lang, ignoreIllegals: true }).value)
}

/** 按扩展名认出的 highlight.js 语言；认不出来时返回空串 */
export function langOf(hl: Hljs | null, path: string) {
  const lang = LANG[path.split('.').pop()?.toLowerCase() ?? '']
  return hl && lang && hl.getLanguage(lang) ? lang : ''
}

/** 整段高亮成 HTML（编辑区的底图用）；认不出语言时返回 null */
export function highlightAll(hl: Hljs | null, code: string, path: string) {
  const lang = langOf(hl, path)
  return lang ? hl!.highlight(code, { language: lang, ignoreIllegals: true }).value : null
}

/** 高亮库按需加载：加载完这次渲染就有颜色了 */
export function useHljs() {
  const [hl, setHl] = useState<Hljs | null>(null)
  useEffect(() => {
    let alive = true
    void ensureHljs().then((h) => alive && setHl(h))
    return () => {
      alive = false
    }
  }, [])
  return hl
}

/** 文件大小：1 KB 以下给字节，再往上给 KB / MB，单位不用翻 */
export function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
