import { marked } from 'marked'
import type { Agent } from '@shared/schema'
import { getLang, t } from '@shared/i18n'

type Hljs = typeof import('highlight.js/lib/common').default
let hljs: Hljs | null = null
let hljsLoad: Promise<Hljs> | null = null
/** 正在渲染的是流式输出中的一段：代码块先不高亮（marked 是同步解析，用模块级标记传进去） */
let liveRender = false

/** highlight.js 体积不小，和 mermaid 一样用到时再加载；加载完调用方重渲染一次就有高亮了 */
export function ensureHljs() {
  hljsLoad ??= import('highlight.js/lib/common').then((m) => (hljs = m.default))
  return hljsLoad
}
export const hljsReady = () => !!hljs

/** 工作流说明的模板：目标、规范、完成标准（步骤在流程图里编辑） */
export function docTemplate(main: Agent | undefined, members: { agent: Agent; responsibility: string }[]) {
  const team = [
    ...(main ? [`- @${main.name}：主 Agent，负责拆分任务和验收`] : []),
    ...members.map((m) => `- @${m.agent.name}：${m.responsibility || m.agent.description || '子 Agent'}`),
  ]
  return `# 目标
用一两句话说明这个工作流要完成什么。

# 分工
${team.length ? team.join('\n') : '- 在上面的「团队」里选择主 Agent 和子 Agent'}

# 规范
- 只改和任务相关的文件，不做无关的重构
- 改动后运行已有的测试

# 完成标准
- 需求里的验收标准逐条满足
- 测试全部通过
`
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// Agent 输出也走这里：只放行 http(s)、mailto 和相对链接，javascript: 之类的链接当普通文字显示
const safe = (href: string) =>
  /^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(href.trim()) || !/^[a-z][\w+.-]*:/i.test(href.trim())

// 渲染器提到模块级：每次渲染都新建一个，长对话里每个增量都做一遍没有意义
const renderer = new marked.Renderer()
renderer.html = ({ text }) => escape(text)
renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens)
  if (!safe(href)) return text
  const ttl = title ? ` title="${escape(title)}"` : ''
  return `<a href="${escape(href)}"${ttl} target="_blank" rel="noopener noreferrer">${text}</a>`
}
// 有替代文字的图片：文字放到图下面当图注（设置里可关）
renderer.image = ({ href, text }) => {
  // 外链图片和内联的位图 / SVG（data:image，img 里的 SVG 不会执行脚本）
  const ok = (safe(href) && /^https?:/i.test(href)) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(href)
  if (!ok) return escape(text)
  const img = `<img src="${escape(href)}" alt="${escape(text)}">`
  return text.trim() ? `<span class="md-fig">${img}<span class="md-cap">${escape(text)}</span></span>` : img
}

/** > [!NOTE] 这类提示块（GitHub 的写法）：五种类型，标题按界面语言显示 */
const ALERTS: Record<string, () => string> = {
  note: () => t('说明'),
  tip: () => t('提示'),
  important: () => t('重要'),
  warning: () => t('注意'),
  caution: () => t('警告'),
}
renderer.blockquote = function ({ tokens }) {
  const body = this.parser.parse(tokens)
  const m = /^<p>\[!(note|tip|important|warning|caution)\]\s*(?:<br>\s*)?/i.exec(body)
  if (!m) return `<blockquote>\n${body}</blockquote>\n`
  const kind = m[1].toLowerCase()
  const rest = ('<p>' + body.slice(m[0].length)).replace(/^<p>\s*<\/p>\s*/, '')
  return `<div class="md-alert" data-kind="${kind}"><p class="md-alert-title">${ALERTS[kind]()}</p>${rest}</div>\n`
}

/**
 * 高亮后的 HTML 按行切开，每行包一个 .md-ln（行号是它的 ::before）。高亮的 span 可能跨行（多行注释、字符串），
 * 切开时在行尾把开着的 span 关掉、下一行开头再原样打开，每行都是完整的标签
 */
export function lineSpans(html: string, diff = false) {
  const lines: string[] = []
  const open: string[] = []
  let cur = ''
  for (const [s] of html.matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g)) {
    if (s === '\n') {
      lines.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
      continue
    }
    if (s === '</span>') open.pop()
    else if (s.startsWith('<span')) open.push(s)
    cur += s
  }
  lines.push(cur)
  // 结尾的换行不算一行
  if (lines.length > 1 && !lines[lines.length - 1].replace(/<[^>]*>/g, '')) lines.pop()
  const out = lines.map((l) => {
    let cls = 'md-ln'
    if (diff) {
      const text = l.replace(/<[^>]*>/g, '')
      if (/^\+(?!\+\+ )/.test(text)) cls += ' md-add'
      else if (/^-(?!-- )/.test(text)) cls += ' md-del'
    }
    return `<span class="${cls}">${l}</span>`
  })
  return { html: out.join('\n'), count: out.length }
}

/** 代码块顶栏：语言名 + 行数，右边折行和复制 */
export function codeBar(name: string, count: number, extra = '') {
  const n = count > 1 ? ` <small>· ${escape(t('{n} 行', { n: count }))}</small>` : ''
  return `<div class="md-code-bar"><span class="md-code-lang">${escape(name)}${n}</span><span class="md-code-acts">${extra}<button type="button" class="md-copy" data-wrap>${t('折行')}</button><button type="button" class="md-copy" data-copy><span class="swap"><span>${t('复制')}</span><span>${t('已复制')}</span></span></button></span></div>`
}
// 代码块参照 Claude Code：顶部一条语言名和复制按钮，内容按语言高亮；mermaid 先显示源码，渲染组件再换成图
renderer.code = ({ text, lang }) => {
  const name = (lang ?? '').trim().split(/\s+/)[0].toLowerCase()
  // 画出来之前（流式输出中、mermaid 还在加载）先显示带行号的源码，上面扫过一道光表示「正在画」
  if (name === 'mermaid') {
    const src = lineSpans(escape(text))
    return `<div class="md-mermaid" data-src="${escape(text)}"><div class="md-code-bar"><span class="md-code-lang">mermaid <small>· ${t('正在绘制')}</small></span></div><pre><code>${src.html}</code></pre></div>`
  }
  let body = escape(text)
  // 流式输出时每 200ms 整段重新渲染，高亮先跳过；这段输出完再高亮一次，最终效果不变
  const ready = liveRender ? null : hljs
  try {
    if (ready && name && ready.getLanguage(name))
      body = ready.highlight(text, { language: name, ignoreIllegals: true }).value
    else if (ready && !name && text.length < 4000) body = ready.highlightAuto(text).value
  } catch {
    // 高亮失败就显示原文
  }
  const lines = lineSpans(body, name === 'diff' || name === 'patch')
  return `<div class="md-code" data-lines="${lines.count}">${codeBar(name || 'text', lines.count)}<pre><code class="hljs">${lines.html}</code></pre></div>`
}

/**
 * 渲染结果缓存。组件里的 useMemo 挡不住这些：切走再切回、blocks 重算、长对话滚回去重新挂载，
 * 都是同样的输入再解析一遍（最长对话 611 条消息）。marked 的输出是纯字符串，
 * 只要 key 把影响结果的东西都带上就能安全复用：文本、团队成员（@提及高亮）、
 * 是否流式（决定代码块高不高亮）、高亮库是否就绪（异步加载的）、当前语言（代码栏里的「复制」）。
 */
const CACHE_MAX = 300
/** 按字符数再卡一道：300 条长回复加起来也不小 */
const CACHE_MAX_CHARS = 2_000_000
const cache = new Map<string, string>()
let cacheChars = 0

const cacheKey = (doc: string, teamNames: Set<string>, lang: string) =>
  `${lang}\u0000${hljs ? 1 : 0}\u0000${[...teamNames].sort().join('\u0001')}\u0000${doc}`

/** 只给测试用：缓存是模块级的，用例之间要能清干净、看清有没有命中 */
export function clearDocCache() {
  cache.clear()
  cacheChars = 0
}

export const docCacheSize = () => cache.size

/**
 * 渲染预览。文档里的原始 HTML 一律转义显示；@提及高亮，不在团队里的标成警告色。
 * live 是流式输出中的一段：跳过代码高亮，等这段输出完再渲染一次。
 */
export function renderDoc(doc: string, teamNames: Set<string>, live = false) {
  // 流式输出每 200ms 换一次文字，存进缓存只会把有用的挤出去
  const key = live ? '' : cacheKey(doc, teamNames, getLang())
  if (key) {
    const hit = cache.get(key)
    if (hit !== undefined) {
      // 命中后挪到末尾：Map 的插入顺序就是最近使用顺序
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
  }
  const html = renderUncached(doc, teamNames, live)
  if (key) {
    cache.set(key, html)
    cacheChars += key.length + html.length
    // 超上限时从最久没用的开始丢
    while (cache.size > CACHE_MAX || cacheChars > CACHE_MAX_CHARS) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cacheChars -= oldest.length + (cache.get(oldest)?.length ?? 0)
      cache.delete(oldest)
    }
  }
  return html
}

function renderUncached(doc: string, teamNames: Set<string>, live: boolean) {
  liveRender = live
  let html: string
  try {
    html = marked.parse(doc, { renderer, async: false, gfm: true, breaks: true }) as string
  } finally {
    // 解析抛错时也要恢复，不能让后面的渲染一直以为在流式输出
    liveRender = false
  }
  // 只替换标签之外的文本里的 @提及；代码块和行内代码里的 @ 原样保留
  return html.replace(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)|[^<]+(?=<|$)|<[^>]*>/g, (part, code) =>
    code || part.startsWith('<') ? part : mention(part, teamNames),
  )
}

function mention(html: string, teamNames: Set<string>) {
  return html.replace(
    /(^|>)([^<]*)/g,
    (_, lead: string, text: string) =>
      lead +
      text.replace(
        /@([^\s@#，。、,.;；:：()（）[\]【】<>&]+)/g,
        (_m, name: string) => `<span class="mention${teamNames.has(name) ? '' : ' unknown'}">@${name}</span>`,
      ),
  )
}
