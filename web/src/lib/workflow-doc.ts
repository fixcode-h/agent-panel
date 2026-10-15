import { marked } from 'marked'
import type { Agent } from '@shared/schema'

/** 按当前团队生成一份工作流文档模板 */
export function docTemplate(main: Agent | undefined, members: { agent: Agent; responsibility: string }[]) {
  const lead = main ? `@${main.name}` : '@主Agent'
  const steps = members.length
    ? members
        .map(
          (m, i) =>
            `## ${i + 2}. ${m.responsibility || m.agent.description || m.agent.name} @${m.agent.name}\n说明这一步要做什么、产出什么，以及完成的判断标准。\n`,
        )
        .join('\n')
    : `## 2. 实现\n说明这一步要做什么、产出什么，以及完成的判断标准。\n`
  return `# 目标
用一两句话说明这个工作流要完成什么。

# 输入
- 用户的需求描述
- 项目目录中的现有代码与文档

# 步骤
## 1. 分析需求、拆分任务 ${lead}
阅读需求，列出要改动的部分和验收标准，再把任务分派给下面的步骤。

${steps}
## ${members.length + 2}. 验收 ${lead}
逐条对照验收标准检查结果，不满足就退回对应步骤。

# 完成标准
- 验收标准逐条满足
- 改动经过测试
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
  const html = marked.parse(doc, { renderer, async: false, gfm: true, breaks: true }) as string
  // 只替换标签之外的文本里的 @提及
  return html.replace(/(^|>)([^<]*)/g, (_, lead: string, text: string) =>
    lead +
    text.replace(/@([^\s@#，。、,.;；:：()（）\[\]【】<>&]+)/g, (_m, name: string) =>
      `<span class="mention${teamNames.has(name) ? '' : ' unknown'}">@${name}</span>`,
    ),
  )
}
