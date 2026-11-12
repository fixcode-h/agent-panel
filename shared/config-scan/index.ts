import { z } from 'zod'
import { maskSecret, secretInLine } from '../secret-rules.ts'
import { EXTRA_WHY, LINE_RULES, type ScanLevel, type ScanSource } from './rules.ts'

export { LINE_RULES, type ScanCategory, type ScanLevel, type ScanSource } from './rules.ts'

/**
 * 配置安全扫描（借鉴 ECC 的 AgentShield，设计稿 designs/ECC借鉴-配置安全扫描与钩子档位-设计稿.md §1）：
 * 插件、Skill、MCP 配置、用户钩子、项目 AGENTS.md 在装进来或第一次用之前，查提示注入、外传、危险命令、过宽权限、密钥。
 * 纯函数，前后端共用；只做确定性的文本匹配，不调模型。扫描只负责让用户看到，不拦使用（插件安装时高级要勾选确认，见界面）。
 *
 * 按来源降权（AgentShield 的做法）：文档里的示例代码、examples/ docs/ 下的文件命中降一级，免得满屏误报；
 * 密钥不降：真密钥写在示例里一样是泄漏
 */

export const ConfigFinding = z.object({
  rule: z.string(),
  category: z.enum(['inject', 'exfil', 'exec', 'mcp', 'secret', 'hook']),
  level: z.enum(['high', 'medium', 'low']),
  /** 相对扫描根的文件（插件包、Skill 目录、项目根）；MCP 配置是「文件#服务名」 */
  file: z.string(),
  /** 从 1 数；结构规则没有行号时为 0 */
  line: z.number().int(),
  /** 那一行（截短，密钥打码） */
  snippet: z.string(),
  why: z.string(),
  /** 降过级（示例代码里）：界面上写一句「在示例里」 */
  example: z.boolean().optional(),
})
export type ConfigFinding = z.infer<typeof ConfigFinding>

export interface ScanFile {
  path: string
  text: string
  /** 不传时按路径猜（guessSource） */
  source?: ScanSource
}

/** 每种级别的条数：徽标、提示条用 */
export interface ScanSummary {
  high: number
  medium: number
  low: number
}

/** 一次最多扫多少字：Skill、插件里的文本文件都不大，超大的多半是数据或打包产物，只扫开头 */
export const SCAN_TEXT_MAX = 256 * 1024
/** 一个文件最多报几条：同一类问题重复出现时看前几条就够了 */
const PER_FILE_MAX = 20
const SNIPPET_MAX = 160
/** 打包压缩过的长行（一行几千字）：只查高级规则，中低级在库代码里误报太多 */
const LONG_LINE = 1000

/** 会扫的文本文件（按扩展名）：md、脚本、配置；图片、模型、压缩包这些不扫 */
export const SCAN_EXT =
  /\.(?:md|mdx|markdown|txt|json|jsonc|toml|ya?ml|sh|bash|zsh|ps1|psm1|bat|cmd|js|mjs|cjs|ts|mts|cts|py|lua|rb)$/i

const extOf = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase()
const slash = (p: string) => p.replace(/\\/g, '/')

/** 按路径猜来源：示例目录里的是示例，json/toml/yaml 是清单，其余是会执行或进提示词的 */
export function guessSource(p: string): ScanSource {
  const s = slash(p).toLowerCase()
  if (/(?:^|\/)(?:examples?|docs?|tests?|__tests__|fixtures?|samples?)\//.test(s)) return 'example'
  if (/\.(?:json|jsonc|toml|ya?ml)$/.test(s)) return 'manifest'
  return 'run'
}

const down = (l: ScanLevel): ScanLevel => (l === 'high' ? 'medium' : 'low')

const cut = (s: string) => {
  const one = s.trim().replace(/\s+/g, ' ')
  return one.length > SNIPPET_MAX ? `${one.slice(0, SNIPPET_MAX)}…` : one
}

/** 零宽字符画出来是空的：片段里换成可见的记号，用户才看得到藏在哪 */
const visible = (s: string) => s.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '⟦?⟧')

/** 扫一个文件的文字 */
export function scanText(file: ScanFile): ConfigFinding[] {
  const ext = extOf(file.path)
  const src = file.source ?? guessSource(file.path)
  const md = ['md', 'mdx', 'markdown'].includes(ext)
  const out: ConfigFinding[] = []
  let fence = false
  const lines = file.text.slice(0, SCAN_TEXT_MAX).replace(/^﻿/, '').split('\n')
  for (let i = 0; i < lines.length && out.length < PER_FILE_MAX; i++) {
    const line = lines[i]
    if (md && /^\s*(?:```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    // md 里代码块之外的正文按原来源算（进提示词），代码块里是示例
    const example = src === 'example' || (md && fence)
    const sec = secretInLine(line)
    if (sec)
      out.push({
        rule: 'secret',
        category: 'secret',
        level: 'high',
        file: file.path,
        line: i + 1,
        snippet: cut(line.replace(sec.value, maskSecret(sec.value))),
        why: EXTRA_WHY.secret(),
      })
    for (const r of LINE_RULES) {
      if (r.ext && !r.ext.includes(ext)) continue
      if (line.length > LONG_LINE && r.level !== 'high') continue
      if (!r.re.test(line)) continue
      out.push({
        rule: r.id,
        category: r.category,
        level: example ? down(r.level) : r.level,
        file: file.path,
        line: i + 1,
        snippet: cut(visible(line)),
        why: r.why(),
        ...(example ? { example: true } : {}),
      })
    }
  }
  return out
}

/** npx / uvx 这类「现拉现跑」的启动器：包名没带版本时每次可能拉到新代码 */
const RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpx'])
const pinned = (pkg: string) => /^@[^/]+\/[^@]+@.+$/.test(pkg) || /^[^@/][^@]*@.+$/.test(pkg) || /==/.test(pkg)

/**
 * MCP 服务的启动方式（结构检查，配置文件里的一条）：没固定版本的 npx / uvx。
 * 其余（监听 0.0.0.0、自动批准、密钥）按文字由 scanText 查
 */
export function scanMcpServer(
  where: string,
  server: { command?: string; args?: string[]; env?: Record<string, string> },
  /** 配置文件里这一条的原文：给了就按原文查（autoApprove 这类面板不认的字段也在里面） */
  raw?: string,
): ConfigFinding[] {
  const out: ConfigFinding[] = []
  const cmd =
    (server.command ?? '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(?:cmd|exe)$/i, '') ?? ''
  const args = server.args ?? []
  if (RUNNERS.has(cmd)) {
    const pkg = args.find((a) => !a.startsWith('-'))
    if (pkg && !pinned(pkg))
      out.push({
        rule: 'mcp.unpinned',
        category: 'mcp',
        level: 'medium',
        file: where,
        line: 0,
        snippet: cut([server.command, ...args].join(' ')),
        why: EXTRA_WHY['mcp.unpinned'](),
      })
  }
  const text = raw ?? JSON.stringify({ command: server.command, args, env: server.env ?? {} }, null, 1)
  out.push(
    ...scanText({ path: `${where}.json`, text, source: 'manifest' }).map((f) => ({ ...f, file: where, line: 0 })),
  )
  return out
}

/** 扫一组文件；只扫 SCAN_EXT 里的文本文件 */
export function scanFiles(files: ScanFile[]): ConfigFinding[] {
  return files.filter((f) => SCAN_EXT.test(f.path)).flatMap(scanText)
}

export function summarize(findings: Pick<ConfigFinding, 'level'>[]): ScanSummary {
  const s: ScanSummary = { high: 0, medium: 0, low: 0 }
  for (const f of findings) s[f.level]++
  return s
}

/** 级别从高到低、同级按文件和行号排：界面直接按这个顺序列 */
export function sortFindings<T extends ConfigFinding>(list: T[]): T[] {
  const rank = { high: 0, medium: 1, low: 2 }
  return [...list].sort((a, b) => rank[a.level] - rank[b.level] || a.file.localeCompare(b.file) || a.line - b.line)
}

/** 忽略一条发现记的键：规则 + 文件 + 那一行（行改了就重新出现） */
export const ignoreKey = (f: Pick<ConfigFinding, 'rule' | 'file' | 'snippet'>, scope = '') =>
  `${scope}|${f.rule}|${f.file}|${f.snippet}`

/** 去掉用户点过「这条没问题」的 */
export const withoutIgnored = <T extends ConfigFinding>(list: T[], ignored: Set<string>, scope = '') =>
  list.filter((f) => !ignored.has(ignoreKey(f, scope)))
