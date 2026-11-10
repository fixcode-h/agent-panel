/**
 * 文件弹窗高亮的纯函数部分：主线程和后台线程（highlight.worker.ts）都用，所以这里不引 React、不引 Markdown 渲染。
 * hljs 由调用方传进来：主线程按需加载，后台线程自己带一份。
 */
import type { HLJSApi } from 'highlight.js'

export type Hljs = HLJSApi
/** 每一行高亮后的 HTML；某一行是 undefined 表示这一行按纯文本画（超长） */
export type HlLines = (string | undefined)[]

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
  // 下一个换行的位置只在越过它之后才重新找：每段文字都从头 indexOf 的话，
  // 一行很长（整张数据表写在一行的 lua / json）时每段都扫到结尾，变成平方级，167 KB 的文件能卡死好几秒
  let nl = html.indexOf('\n')
  while (i < html.length) {
    if (html[i] === '\n') {
      out.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
      i++
      nl = html.indexOf('\n', i)
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

/**
 * 一行超过这么多字就不上色、按纯文本画：整张数据表写在一行的 lua / json 高亮后一行有几万个 <span>，
 * 浏览器排这一行就要好几秒（用户 2026-11-07 报打开 167 KB 的 lua 卡死）。纯文本的一长行排版很快
 */
export const LONG_LINE = 3000

/**
 * 高亮每一行；语言认不出来时返回 null，调用方按纯文本显示。
 * 超长的行先换成空行再交给 highlight.js（结果里这一行是 undefined，调用方按纯文本画）：省掉给它上色的工夫，
 * 也不会因为这一行里没配对的引号把后面几千行都染成字符串
 */
export function highlightLines(hl: Hljs | null, code: string, path: string) {
  const lang = langOf(hl, path)
  if (!lang || !code) return null
  const src = code.split('\n')
  const long = src.map((l) => l.length > LONG_LINE)
  const text = long.includes(true) ? src.map((l, i) => (long[i] ? '' : l)).join('\n') : code
  const out: (string | undefined)[] = splitHtmlLines(
    hl!.highlight(text, { language: lang, ignoreIllegals: true }).value,
  )
  long.forEach((on, i) => on && (out[i] = undefined))
  return out
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 占两格的字（中日韩文字、全角符号）：估算一行有多宽时按两格算；emoji 在字符串里本来就占两个长度，不用另算 */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/g

/**
 * 最长一行大约多少个字宽（ch）：分块懒渲染时屏幕外的块不排版，宽度要事先按最长的一行撑好，
 * 不然往下滚到长行时横向滚动条才突然变长。制表符按 tabSize 对齐
 */
export function maxCols(lines: string[], tabSize: number) {
  let max = 0
  for (const l of lines) {
    // 一个字最多占两格：长度的两倍都比现在的最大值小，这一行不用细算
    if (l.length * 2 <= max) continue
    let cols = 0
    if (l.includes('\t')) {
      for (const c of l) cols = c === '\t' ? cols + tabSize - (cols % tabSize) : cols + 1
    } else cols = l.length
    cols += l.match(WIDE)?.length ?? 0
    max = Math.max(max, cols)
  }
  return max
}

/** 按扩展名认出的 highlight.js 语言；认不出来时返回空串 */
export function langOf(hl: Hljs | null, path: string) {
  const lang = LANG[path.split('.').pop()?.toLowerCase() ?? '']
  return hl && lang && hl.getLanguage(lang) ? lang : ''
}

/** 一行高亮好的 HTML 拆成「从第几个字到第几个字、什么 class」：每个 <span> 一段，嵌套的照样嵌套（编辑器按它上色） */
export function htmlSpans(html: string) {
  const out: { from: number; to: number; cls: string }[] = []
  const stack: { from: number; cls: string }[] = []
  let pos = 0
  for (let i = 0; i < html.length;) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i)
      const tag = html.slice(i, end < 0 ? html.length : end + 1)
      if (tag.startsWith('</')) {
        const top = stack.pop()
        if (top && top.cls && pos > top.from) out.push({ from: top.from, to: pos, cls: top.cls })
      } else stack.push({ from: pos, cls: /class="([^"]*)"/.exec(tag)?.[1] ?? '' })
      i = end < 0 ? html.length : end + 1
      continue
    }
    if (html[i] === '&') {
      const semi = html.indexOf(';', i)
      i = semi > i && semi - i <= 10 ? semi + 1 : i + 1
    } else i++
    pos++
  }
  return out
}
