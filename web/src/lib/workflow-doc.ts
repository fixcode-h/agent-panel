import { marked } from 'marked'
import type { Agent } from '@shared/schema'

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

/**
 * 渲染预览。文档里的原始 HTML 一律转义显示；@提及高亮，不在团队里的标成警告色。
 */
export function renderDoc(doc: string, teamNames: Set<string>) {
  const renderer = new marked.Renderer()
  renderer.html = ({ text }) => escape(text)
  // Agent 输出也走这里：只放行 http(s)、mailto 和相对链接，javascript: 之类的链接当普通文字显示
  const safe = (href: string) =>
    /^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(href.trim()) || !/^[a-z][\w+.-]*:/i.test(href.trim())
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens)
    if (!safe(href)) return text
    const t = title ? ` title="${escape(title)}"` : ''
    return `<a href="${escape(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`
  }
  renderer.image = ({ href, text }) =>
    safe(href) && /^https?:/i.test(href) ? `<img src="${escape(href)}" alt="${escape(text)}">` : escape(text)
  const html = marked.parse(doc, { renderer, async: false, gfm: true, breaks: true }) as string
  // 只替换标签之外的文本里的 @提及
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
