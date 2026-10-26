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

/** 文件树里的一项：目录、文件、或软链接（链接 可能是文件也可能是目录，不跟进去） */
export interface LibraryEntry {
  path: string
  type: 'file' | 'dir' | 'link'
  /** 字节数，只有普通文件有 */
  size?: number
}

/** 文件树：目录在前、按名字排的扁平列表（父目录一定排在子项前面），前端按 / 分段就能画成树 */
export interface LibraryTree {
  entries: LibraryEntry[]
  /** 条目太多被截断了（保留浅层的），前端据此提示 */
  truncated?: boolean
}

export interface LibraryFile {
  /** 主文件（SKILL.md / 命令文件）的内容 */
  content: string
  /** 主文件以外的文件（相对路径，扁平列表；等于 entries 里 type 为 file 的 path） */
  files: string[]
  /** 完整文件树（目录 + 文件），命令没有附带的目录结构时是 undefined */
  tree?: LibraryTree
}

/** 单个附带文件：读出来是文本就带 content，二进制只有 size 和 binary；软链接只标记、不给内容 */
export interface LibraryEntryContent {
  path: string
  /** 文件或链接存在就为 true（读一个还没建的文件不算错误，返回 false） */
  exists: boolean
  binary?: boolean
  /** 路径上是个软链接（不管链到文件还是目录），可以看、可以删，不能在这里改内容 */
  link?: boolean
  content: string
  size: number
  mtime?: string
}

/** 写一个附带文件的结果 */
export interface LibraryWriteResult {
  path: string
  /** 写进去的字节数 */
  bytes: number
}

/** 改名 / 移动：Skill 目录内的相对路径（前端的请求形状，服务端按字段读） */
export interface LibraryRenameRequest {
  cli: string
  kind: 'skill' | 'command'
  name: string
  from: string
  to: string
  /** 目标已存在时是否覆盖；默认 false，目标存在就报错 */
  overwrite?: boolean
}

/** 单个附带文件的上限（1 MiB）：读写都限，防止几 MB 的二进制被读进 JSON 卡住面板和浏览器 */
export const LIBRARY_FILE_MAX_BYTES = 1024 * 1024
/** 上限在报错文案里怎么说：按 KiB 报，和「1.0 MB」的显示口径一致（1048 KB 会自相矛盾） */
export const LIBRARY_FILE_MAX_KIB = LIBRARY_FILE_MAX_BYTES / 1024
/** 文件树最多列多少项（目录也算一项）：一个技能塞几千个文件时别把响应撑爆 */
export const LIBRARY_TREE_MAX_ENTRIES = 1000
/** 递归删目录前要数的条目上限：超过就让用户自己确认，避免一次删掉整个技能的快照目录 */
export const LIBRARY_DIR_MAX_DELETE_ENTRIES = 1000
/** 文件树不列的目录：只挡工具链的依赖和缓存，不拿搜索用的噪音表：技能里的 `logs/`、`build/` 可能是真内容 */
export const LIBRARY_TREE_EXCLUDE_DIRS = ['node_modules', '.git', '.svn', '__pycache__', '.venv', 'venv']
/** 文件树不列的文件：系统生成的垃圾文件，不是技能内容 */
export const LIBRARY_TREE_EXCLUDE_FILES = ['.DS_Store', 'Thumbs.db']

/**
 * 已知路径的文件树（不知道磁盘上的目录也可以调）：
 * 按路径补出每一级父目录，同层目录排在文件前面、再按名字排，超出上限截断并标 truncated。
 * 自带技能（文件内容在内存里）和演示数据（只在内存里）走这一份，不要各自再写一套排序。
 */
export function treeFromPaths(files: { path: string; size: number }[]): LibraryTree {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const entries: LibraryEntry[] = [
    ...[...dirs].map((path) => ({ path, type: 'dir' as const })),
    ...files.map((f) => ({ path: f.path, type: 'file' as const, size: f.size })),
  ]
  // 按层级逐段比：同一层里目录排在文件前面（前端的 toTree 依赖这个顺序）
  entries.sort((a, b) => {
    const ap = a.path.split('/')
    const bp = b.path.split('/')
    for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
      if (ap[i] === bp[i]) continue
      const aDir = i < ap.length - 1 || a.type === 'dir'
      const bDir = i < bp.length - 1 || b.type === 'dir'
      if (aDir !== bDir) return aDir ? -1 : 1
      return ap[i].localeCompare(bp[i])
    }
    return a.path.localeCompare(b.path)
  })
  return entries.length > LIBRARY_TREE_MAX_ENTRIES
    ? { entries: entries.slice(0, LIBRARY_TREE_MAX_ENTRIES), truncated: true }
    : { entries }
}

/** Skill 文件夹名、命令名：字母数字开头，只含字母数字和 . _ -；命令的子目录用「:」分隔 */
export const libraryName = (kind: 'skill' | 'command', name: string) => {
  const part = /^[A-Za-z0-9][\w.-]*$/
  return kind === 'skill' ? part.test(name) : name.split(':').every((p) => part.test(p))
}

/**
 * 附带文件的相对路径是否允许：逐段校验，挡掉绝对路径、盘符、`..`、空段和控制字符。
 * Skill 目录里的文件是用户自己放的脚本和参考文档，段名比技能名宽松（允许空格、中文），
 * 但每一段都不能为空、不能是 `.` / `..`、不能带分隔符和 Windows 的非法字符
 */
export function libraryEntryPath(target: string) {
  const raw = target.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (!raw) throw new Error(t('要填文件路径'))
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0'))
    throw new Error(t('路径只能填 Skill 目录里的相对路径'))
  const parts = raw.split('/')
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new Error(t('路径只能填 Skill 目录里的相对路径'))
    if (/[<>:"|?*]/.test(p)) throw new Error(t('路径里不能有 {chars}', { chars: '< > : " | ? *' }))
  }
  return parts.join('/')
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
  /**
   * SKILL.md 以外的文件结构（和用户技能的 LibraryTree 同一形状，目录在前、按名字排）：
   * 详情页用它画出「这个技能带哪些文件」，不自带目录时没有这一项。
   */
  tree?: LibraryTree
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
