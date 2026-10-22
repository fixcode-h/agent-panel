import { marked } from 'marked'
import type { Agent } from '@shared/schema'
import { t } from '@shared/i18n'

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

/** 文档大纲：取出一级和二级标题 */
export function docOutline(doc: string) {
  return [...doc.matchAll(/^(#{1,2})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2].trim() }))
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
renderer.image = ({ href, text }) =>
  safe(href) && /^https?:/i.test(href) ? `<img src="${escape(href)}" alt="${escape(text)}">` : escape(text)
// 代码块参照 Claude Code：顶部一条语言名和复制按钮，内容按语言高亮；mermaid 先显示源码，渲染组件再换成图
renderer.code = ({ text, lang }) => {
  const name = (lang ?? '').trim().split(/\s+/)[0].toLowerCase()
  if (name === 'mermaid')
    return `<div class="md-mermaid" data-src="${escape(text)}"><pre><code>${escape(text)}</code></pre></div>`
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
  return `<div class="md-code"><div class="md-code-bar"><span>${escape(name || 'text')}</span><button type="button" class="md-copy" data-copy>${t('复制')}</button></div><pre><code class="hljs">${body}</code></pre></div>`
}

/**
 * 渲染预览。文档里的原始 HTML 一律转义显示；@提及高亮，不在团队里的标成警告色。
 * live 是流式输出中的一段：跳过代码高亮，等这段输出完再渲染一次。
 */
export function renderDoc(doc: string, teamNames: Set<string>, live = false) {
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
        /@([^\s@#，。、,.;；:：()（）\[\]【】<>&]+)/g,
        (_m, name: string) => `<span class="mention${teamNames.has(name) ? '' : ' unknown'}">@${name}</span>`,
      ),
  )
}
