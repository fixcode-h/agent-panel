import { marked } from 'marked'
import { mathExtensions } from './md-math'

// 数学公式：先出带原文的占位，渲染组件再懒加载 KaTeX 换成公式（md-math.ts）
marked.use({ extensions: mathExtensions })
// 删除线只认双波浪号 ~~：marked 的 GFM 默认单个 ~ 也算删除线，模型常用 ~ 写范围（「X 0~512、Y 0~256」），
// 两个 ~ 之间的文字就被划掉了。单个 ~ 开头时返回 undefined（不是 false，false 会退回默认规则），按普通文字显示
marked.use({ tokenizer: { del: (src) => (src.startsWith('~~') ? false : undefined) } })
import type { Agent } from '@shared/schema'
import { getLang, t } from '@shared/i18n'
import type { LineMark } from '@shared/bug/quotes-md'
import { markdownDiff } from './diff-html'
import { tableHtml } from './markdown/table'
import { callTreeHtml } from './markdown/call-tree'

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
/** 加载好的 highlight.js（没加载返回 null）：diff 组件按文件语言着色用 */
export const loadedHljs = () => hljs

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
// 判断前先去掉所有空白和控制字符：浏览器解析地址时会把它们删掉，`java\tscript:` 照样是 javascript:，
// 只 trim 的话正则匹配不上协议、反而被当成相对链接放行
const safe = (href: string) => {
  // oxlint-disable-next-line no-control-regex -- 故意匹配控制字符（浏览器解析 URL 时会删掉它们）
  const h = href.replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
  return /^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(h) || !/^[a-z][\w+.-]*:/i.test(h)
}

// 渲染器提到模块级：每次渲染都新建一个，长对话里每个增量都做一遍没有意义
const renderer = new marked.Renderer()
// 原样 HTML 一律转义；只放行 <br>：表格单元格里没别的办法换行（诊断报告的表格，shared/bug/diagnosis-md.ts）
renderer.html = ({ text }) => (/^<br\s*\/?>$/i.test(text.trim()) ? '<br>' : escape(text))
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

// 表格包一层：悬停工具条（复制、全屏）、点表头排序（web/src/lib/markdown/table.ts）
const tableDefault = renderer.table
renderer.table = function (token) {
  return tableHtml(tableDefault.call(this, token), token.raw, token.rows.length)
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

/** 代码块信息串里的 marks=（URL 编码的 JSON）；写坏了就当没有 */
function lineMarks(info: string): LineMark[] {
  const raw = /(?:^|\s)marks=(\S+)/.exec(info)?.[1]
  if (!raw) return []
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as unknown
    return Array.isArray(v) ? (v as LineMark[]).filter((m) => m && Number.isFinite(m.l)) : []
  } catch {
    return []
  }
}

const LINE_CLASS: Record<NonNullable<LineMark['v']>, string> = {
  fault: 'md-mark',
  related: 'md-rel',
  skipped: 'md-skip',
  dim: 'md-dim',
}

/** 每行按标记加样式：整行的级别、行内那几个字（md-hit）、行尾说明（md-note，选中复制时不带） */
function applyMarks(html: string, start: number, marks: LineMark[]): string {
  return html
    .split('\n')
    .map((l, i) => {
      const mine = marks.filter((m) => m.l === start + i)
      if (!mine.length) return l
      const strong = mine.find((m) => m.v === 'fault') ?? mine.find((m) => m.v && m.v !== 'related') ?? mine[0]
      // 有行内高亮的相关行只高亮那几个字，不再整行着色
      const whole = strong.v && (strong.v !== 'related' || !mine.some((m) => m.t)) ? LINE_CLASS[strong.v] : ''
      let out = whole ? l.replace('class="md-ln', `class="md-ln ${whole}`) : l
      for (const m of mine) if (m.t) out = wrapText(out, m.t, m.v === 'fault' ? 'md-hit md-hit-fault' : 'md-hit')
      const notes = mine.filter((m) => m.n).map((m) => `<span class="md-note">${escape(`← ${m.n}`)}</span>`)
      return notes.length ? out.replace(/<\/span>$/, `${notes.join('')}</span>`) : out
    })
    .join('\n')
}

/**
 * 在一行高亮好的 HTML 里给一段原文套上 <mark>：按去掉标签、解开实体后的文字找位置，
 * 跨过语法高亮的 <span> 时先关上再打开，标签不会交错
 */
function wrapText(html: string, text: string, cls: string): string {
  const parts = html.match(/<[^>]*>|&[#\w]+;|[^<&]/g) ?? []
  const plain = parts.map((p) => (p.startsWith('<') ? '' : p.startsWith('&') && p.length > 1 ? decodeEntity(p) : p))
  const joined = plain.join('')
  const from = joined.indexOf(text)
  if (from < 0) return html
  const to = from + text.length
  let pos = 0
  let open = false
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const len = plain[i].length
    if (!len) {
      out += open ? `</mark>${p}<mark class="${cls}">` : p
      continue
    }
    if (!open && pos >= from && pos < to) {
      out += `<mark class="${cls}">`
      open = true
    }
    out += p
    pos += len
    if (open && pos >= to) {
      out += '</mark>'
      open = false
    }
  }
  return out.replace(new RegExp(`<mark class="${cls}"></mark>`, 'g'), '')
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
}
const decodeEntity = (e: string) =>
  ENTITIES[e] ?? (/^&#(\d+);$/.test(e) ? String.fromCodePoint(Number(e.slice(2, -1))) : e)

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
  // 调用栈树（诊断报告、回复里的 calltree 代码块，markdown/call-tree.ts）
  if (name === 'calltree') return callTreeHtml(text)
  // diff 和界面里别处的 diff 一个画法（diff-html.ts）；夹着别的文字认不出时照普通代码块画
  if (name === 'diff' || name === 'patch') {
    const diff = markdownDiff(text, lang ?? '', liveRender ? null : hljs, codeBar)
    if (diff) return diff
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
  // 信息串里的 start=48 mark=52 marks=…（诊断报告的关键代码和原文，shared/bug/diagnosis-md.ts、bug-quotes-md.ts）：
  // 行号从文件里的真实行开始，出错那行、行内那几个字、行尾说明、临时日志行标出来
  const start = Number(/(?:^|\s)start=(\d+)/.exec(lang ?? '')?.[1] ?? 1)
  const mark = Number(/(?:^|\s)mark=(\d+)/.exec(lang ?? '')?.[1] ?? 0)
  const marks = lineMarks(lang ?? '')
  if (mark >= start) marks.push({ l: mark, v: 'fault' })
  const html = marks.length ? applyMarks(lines.html, start, marks) : lines.html
  const reset = start > 1 ? ` style="counter-reset: md-ln ${start - 1}"` : ''
  return `<div class="md-code" data-lines="${lines.count}">${codeBar(name || 'text', lines.count)}<pre><code class="hljs"${reset}>${html}</code></pre></div>`
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
