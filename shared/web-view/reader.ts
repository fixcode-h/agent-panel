/**
 * 阅读模式：把网页 HTML 取出正文转成 Markdown。服务端和演示后端用同一份（没有 DOM，按标签流处理）。
 *
 * 不追求还原排版，只要标题、段落、列表、链接、图片、代码块、引用能读；脚本、样式、导航、页脚、表单整块丢掉。
 * 有 <article> 就只取它，其次 <main>，再其次 <body>。结果交给对话同一套 Markdown 渲染，原 HTML 不进页面。
 */

/** 整块丢掉（连里面的文字）的标签 */
// 模块状态：常量，加载后不改
const DROP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'textarea',
  'dialog',
])
/** 块级标签：前后断行 */
// 模块状态：常量，加载后不改
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'ul',
  'ol',
  'table',
  'tr',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'hr',
])

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function attr(tag: string, name: string) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : ''
}

/** 相对地址按页面地址补全；javascript: 这类直接丢掉 */
function absolute(href: string, base: string) {
  try {
    const u = new URL(href, base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : ''
  } catch {
    return ''
  }
}

/** 取出正文所在的那一段：article > main > body > 全文 */
function pickRoot(html: string) {
  for (const tag of ['article', 'main', 'body']) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)
    // 太短的 article 多半是侧栏里的卡片，不当正文
    if (m && (tag === 'body' || m[1].replace(/<[^>]+>/g, '').trim().length > 200)) return m[1]
  }
  return html
}

export function pageTitle(html: string) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

/** 正文最多这么长：再长的页面阅读模式也只给前面一段，免得回给界面的 JSON 太大 */
const MAX_MD = 200_000

export function htmlToMarkdown(html: string, base: string) {
  const src = pickRoot(html.replace(/<!--[\s\S]*?-->/g, ''))
  const out: string[] = []
  let drop = 0
  let dropTag = ''
  let pre = 0
  let list: ('ul' | 'ol')[] = []
  const counters: number[] = []
  let link: { href: string; at: number } | null = null
  const push = (s: string) => out.push(s)
  const br = (n = 1) => push('\n'.repeat(n))
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|[^<]+|</g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const tok = m[0]
    const name = m[1]?.toLowerCase()
    if (!name) {
      if (drop) continue
      const text = decodeEntities(tok)
      push(pre ? text : text.replace(/\s+/g, ' '))
      continue
    }
    const closing = tok[1] === '/'
    if (drop) {
      // 被丢掉的块里嵌了同名标签时数着层数，最外层关上才恢复
      if (name === dropTag) drop += closing ? -1 : tok.endsWith('/>') ? 0 : 1
      continue
    }
    if (DROP.has(name) && !closing) {
      if (!tok.endsWith('/>')) {
        drop = 1
        dropTag = name
      }
      continue
    }
    if (/^h[1-6]$/.test(name)) {
      br(2)
      if (!closing) push(`${'#'.repeat(Number(name[1]))} `)
      continue
    }
    switch (name) {
      case 'br':
        push(pre ? '\n' : '  \n')
        break
      case 'pre':
        // 代码块的开头前空一行；结尾的 ``` 紧跟代码另起一行，再空一行
        push(closing ? '\n```\n\n' : '\n\n```\n')
        pre += closing ? -1 : 1
        break
      case 'code':
        if (!pre) push('`')
        break
      case 'strong':
      case 'b':
        push('**')
        break
      case 'em':
      case 'i':
        push('*')
        break
      case 'blockquote':
        br(2)
        if (!closing) push('> ')
        break
      case 'ul':
      case 'ol':
        if (closing) {
          list = list.slice(0, -1)
          counters.pop()
        } else {
          list = [...list, name]
          counters.push(0)
        }
        br()
        break
      case 'li':
        if (closing) break
        br()
        {
          const kind = list[list.length - 1] ?? 'ul'
          const depth = Math.max(0, list.length - 1)
          const n = counters.length ? ++counters[counters.length - 1] : 1
          push(`${'  '.repeat(depth)}${kind === 'ol' ? `${n}.` : '-'} `)
        }
        break
      case 'a':
        if (!closing) {
          const href = absolute(attr(tok, 'href'), base)
          link = href ? { href, at: out.length } : null
          if (link) push('[')
        } else if (link) {
          const text = out
            .slice(link.at + 1)
            .join('')
            .trim()
          // 没有文字的链接（只包着图片或图标）不留空方括号
          if (text) push(`](${link.href})`)
          else out.splice(link.at, 1)
          link = null
        }
        break
      case 'img': {
        const s = absolute(attr(tok, 'src'), base)
        if (s) push(`![${attr(tok, 'alt').replace(/[[\]]/g, '')}](${s})`)
        break
      }
      case 'td':
      case 'th':
        if (!closing) push(' | ')
        break
      default:
        if (BLOCK.has(name)) br(name === 'li' ? 1 : 2)
    }
  }
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*\s*\*\*/g, '')
    .trim()
    .slice(0, MAX_MD)
}
