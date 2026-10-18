import { z } from 'zod'

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
