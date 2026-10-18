/**
 * 项目说明文件：各个 CLI 每次启动时自动读的 Markdown（项目约定、常用命令、架构说明）。
 * 项目设置里能看、能改、能让 AI 优化。
 *
 * 每个 CLI 读哪些文件写在它的定义里（docs），例如 Claude Code 读 CLAUDE.md，Codex 读 AGENTS.md。
 * AGENT.md（少了 s）哪个 CLI 都不读，检测到时提醒改名
 */
import { z } from 'zod'
import { CLIS, getCli } from './clis.ts'

/** 项目说明文件相对项目目录的路径 */
export type DocFile = string

/** 能看、能改的说明文件：各个 CLI 定义里写的（docs），加上通用的 AGENTS.md 和写错名字的 AGENT.md */
export const docFiles = (): DocFile[] => [...new Set(['AGENTS.md', ...CLIS.flatMap((c) => c.docs), 'AGENT.md'])]

/** 每个 CLI 读哪些说明文件；第一个是还没有文件时新建的那个 */
export const cliDocs = (id: string): DocFile[] => getCli(id)?.docs ?? []

const DocPath = z.string().refine((p) => docFiles().includes(p), '不是项目说明文件')

/** 通用的项目说明：多个 CLI 共用 */
export const SHARED_DOC: DocFile = 'AGENTS.md'

/** 读得到的说明文件内容；太大的文件不读（说明文件一般几 KB） */
export const DOC_MAX = 512 * 1024

export interface ProjectDoc {
  path: DocFile
  exists: boolean
  content: string
  bytes: number
  /** 文件太大没有读内容 */
  tooLarge?: boolean
}

export interface ProjectDocs {
  /** 项目目录 */
  dir: string
  files: ProjectDoc[]
}

export const DocWrite = z.object({
  path: DocPath,
  content: z.string().max(DOC_MAX),
})

export const DocOptimizeInput = z.object({
  path: DocPath,
  /** 编辑器里当前的内容（可能还没保存） */
  content: z.string().max(DOC_MAX),
  /** 想怎么改；为空时按通用的标准优化 */
  request: z.string().trim().max(4000).default(''),
  cli: z.string().min(1),
  model: z.string().trim().default(''),
  effort: z.string().trim().default(''),
})
export type DocOptimizeInput = z.infer<typeof DocOptimizeInput>

export interface DocJob {
  id: string
  path: DocFile
  status: 'running' | 'done' | 'failed'
  /** CLI 说明改了什么（代码块前后的文字） */
  text: string
  /** 优化后的完整文件内容 */
  result?: string
  error?: string
  thinking?: string
  tools?: string[]
  outChars?: number
  startedAt: number
}

/**
 * 给 CLI 的提示：只读项目代码核对，不改文件，把完整的新内容放在一个 markdown 代码块里。
 * 提示词固定用中文，和其他发给 Agent 的提示一样
 */
export function docOptimizePrompt(input: DocOptimizeInput, clis: string[]) {
  return [
    `你在帮忙优化项目根目录下的说明文件「${input.path}」。${clis.length ? `这个文件会被 ${clis.join('、')} 在每次启动时读入，作为在这个项目里工作的约定。` : ''}`,
    '',
    '要求：',
    '- 先看一下项目的目录结构、package.json / 构建脚本、README 等，核对文件里写的命令、目录、约定是不是和项目实际一致，不一致的改正，缺的重要信息补上。',
    '- 保留原文件里仍然正确、有用的内容和原来的语言；写给编码助手看：简洁、具体、能照着做，不写空话。',
    '- 不要修改项目里的任何文件，只在回答里给出结果。',
    input.request ? `- 用户的要求：${input.request}` : '',
    '',
    '回答的格式：先用一两句话说明改了什么，然后把完整的新文件内容放在一个 ```markdown 代码块里（只放一个代码块，内容是完整文件，不是片段）。',
    '',
    `当前「${input.path}」的内容${input.content.trim() ? '：' : '是空的（文件还不存在），请根据项目情况写一份。'}`,
    input.content.trim() ? '\n<<<文件开始\n' + input.content + '\n文件结束>>>' : '',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** 从回答里取出最后一个 markdown 代码块；代码块里可以再嵌套 ``` */
export function extractDoc(text: string): { content?: string; rest: string } {
  const start = text.search(/```(?:markdown|md)\s*\n/i)
  if (start < 0) return { rest: text.trim() }
  const bodyStart = text.indexOf('\n', start) + 1
  // 结束标记取最后一个独占一行的 ```，内容里的代码示例不会被截断
  const ends = [...text.slice(bodyStart).matchAll(/^```\s*$/gm)]
  const end = ends.length ? bodyStart + ends.at(-1)!.index! : text.length
  const content = text.slice(bodyStart, end).replace(/\s+$/, '') + '\n'
  const rest = (text.slice(0, start) + text.slice(end).replace(/^```\s*/, '')).trim()
  return { content, rest }
}
