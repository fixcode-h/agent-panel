import { z } from 'zod'
import { t } from './i18n.ts'

/** 库里的一项：某个 CLI 用户目录下的一个 Skill 或自定义命令 */
export interface LibraryItem {
  cli: string
  kind: 'skill' | 'command'
  /** 文件夹名（Skill）或命令名（子目录用「:」分隔） */
  name: string
  description: string
  path: string
}

export interface LibraryCli {
  id: string
  name: string
  /** 用户级 Skill、命令放在哪（空表示面板不管） */
  skillDir: string
  commandDir: string
  commandFormat: 'md' | 'toml'
}

export interface LibraryFile {
  content: string
  /** Skill 文件夹里 SKILL.md 以外的文件（相对路径） */
  files: string[]
}

/** Skill 文件夹名、命令名：字母数字开头，只含字母数字和 . _ -；命令的子目录用「:」分隔 */
export const libraryName = (kind: 'skill' | 'command', name: string) => {
  const part = /^[A-Za-z0-9][\w.-]*$/
  return kind === 'skill' ? part.test(name) : name.split(':').every((p) => part.test(p))
}

/** 面板管的一个 MCP 工具：本地进程（stdio）或远程地址（http） */
export const McpServer = z.object({
  name: z.string().regex(/^[A-Za-z0-9][\w-]*$/),
  transport: z.enum(['stdio', 'http']),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({}),
})
export type McpServer = z.infer<typeof McpServer>

export interface McpEntry extends McpServer {
  /** 装在哪些 CLI 里 */
  clis: string[]
}

export interface McpOverview {
  /** 面板能管 MCP 工具的 CLI，和它们的配置文件 */
  clis: { id: string; name: string; file: string }[]
  servers: McpEntry[]
}

export interface McpTestResult {
  ok: boolean
  error?: string
  server?: string
  tools: { name: string; description: string }[]
}

/** 面板自带的 Skill（仓库的 skills/<分类>/<名字>/），统一装到用户目录 ~/.agents/skills，各 CLI 共用 */
export interface BundledSkill {
  name: string
  /** 分类文件夹名，显示名见 BUNDLED_CATEGORIES */
  category: string
  description: string
  /** SKILL.md 以外的文件数 */
  files: number
  /** 在用户共享目录里的状态：没装、和自带的一样、装了但内容不同（自带的更新了或用户改过） */
  status: Record<string, 'missing' | 'same' | 'changed'>
}

export const BUNDLED_CATEGORIES: { id: string; label: string }[] = [
  { id: 'workflow', label: t('流程') },
  { id: 'coding', label: t('编码') },
  { id: 'docs', label: t('文档') },
  { id: 'vcs', label: t('版本控制') },
  { id: 'ue', label: 'UE' },
  { id: 'art', label: t('美术') },
]

/** SKILL.md 开头 front matter 里的一个字段，支持引号和 | > 多行写法 */
export function frontField(text: string, key: string) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const lines = fm.split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (i < 0) return ''
  const v = lines[i].slice(key.length + 1).trim()
  if (/^[|>][-+]?$/.test(v)) {
    const body: string[] = []
    for (const l of lines.slice(i + 1)) {
      if (l && !/^\s/.test(l)) break
      body.push(l.trim())
    }
    return body.join(v.startsWith('|') ? '\n' : ' ').trim()
  }
  return v.replace(/^(["'])([\s\S]*)\1$/, '$2')
}
