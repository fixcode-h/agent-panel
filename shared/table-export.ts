/**
 * 导表脚本：项目设置 → 表格里配好的命令（比如 python tools/export.py {file}），在表格页对一张表、一个文件夹或全部表执行。
 * 命令里写占位，执行时才换成真实路径（按当前的命令行环境加引号）；路径里有空格、中文都不用用户操心。
 */
import { z } from 'zod'

// 名字、命令允许先空着：设置里一项一项填，填到一半也要能存进表单
export const TableExport = z.object({
  name: z.string().max(60).default(''),
  command: z.string().max(2000).default(''),
  /** 在哪个目录执行：相对项目目录或绝对路径，空的是项目目录 */
  cwd: z.string().trim().max(300).default(''),
  /** 最多跑多久（分钟），到点停掉 */
  timeoutMin: z.number().int().min(1).max(240).default(30),
  /** 在表格页保存一张表后，自动对这张表执行一次 */
  onSave: z.boolean().optional(),
})
export type TableExport = z.infer<typeof TableExport>

/** 显示用的名字：没起名时用命令开头 */
export const exportName = (x: TableExport, i: number) => x.name.trim() || x.command.trim().slice(0, 40) || `#${i + 1}`

/** 命令里能写的占位；有 {files} 时所有表一次传进去，没有时每张表各执行一次 */
export const EXPORT_VARS = ['file', 'files', 'rel', 'name', 'folder', 'project'] as const
export type ExportVar = (typeof EXPORT_VARS)[number]

/** 一张表的占位值（都是完整路径，rel 除外） */
export interface ExportTarget {
  file: string
  rel: string
}

/** 命令行环境：决定路径怎么加引号 */
export type QuoteStyle = 'sh' | 'cmd' | 'powershell'

export function quoteFor(style: QuoteStyle, s: string) {
  if (style === 'cmd') return `"${s}"`
  if (style === 'powershell') return `'${s.replace(/'/g, "''")}'`
  // sh：纯字母数字和常见路径字符不用加，其余用单引号包起来
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

const baseName = (p: string) => p.replace(/\\/g, '/').replace(/.*\//, '')
const dirName = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

/** 已经在引号里面时，值里会打断这对引号的字符要转义 */
function inQuote(style: QuoteStyle, q: string, s: string) {
  if (q === "'") return style === 'powershell' ? s.replace(/'/g, "''") : style === 'sh' ? s.replace(/'/g, `'\\''`) : s
  if (style === 'sh') return s.replace(/["\\$`]/g, '\\$&')
  if (style === 'powershell') return s.replace(/["$`]/g, '`$&')
  return s
}

/**
 * 把占位换成真实值。占位已经写在引号里（"{file}"、"out/{name}.json"）就不再加一层，只转义会打断引号的字符；
 * 不认识的 {xxx} 原样留着（脚本自己的花括号语法不受影响）
 */
export function fillCommand(command: string, vars: Partial<Record<ExportVar, string | string[]>>, style: QuoteStyle) {
  let out = ''
  // 现在在哪种引号里（cmd 只认双引号）
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const m = ch === '{' ? /^\{(\w+)\}/.exec(command.slice(i)) : null
    const v = m && (EXPORT_VARS as readonly string[]).includes(m[1]) ? vars[m[1] as ExportVar] : undefined
    if (m && v !== undefined) {
      const list = Array.isArray(v) ? v : [v]
      out += quote ? list.map((x) => inQuote(style, quote, x)).join(' ') : list.map((x) => quoteFor(style, x)).join(' ')
      i += m[0].length - 1
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      // sh 双引号里的反斜杠转义下一个字符
      else if (ch === '\\' && style === 'sh' && quote === '"' && i + 1 < command.length) {
        out += ch + command[++i]
        continue
      }
    } else if (ch === '"' || (ch === "'" && style !== 'cmd')) quote = ch
    out += ch
  }
  return out
}

/** 要执行的几行命令：有 {files} 时一行（所有表），否则每张表一行 */
export function exportLines(command: string, targets: ExportTarget[], project: string, style: QuoteStyle): string[] {
  if (!targets.length) return []
  if (/\{files\}/.test(command))
    return [
      fillCommand(
        command,
        {
          files: targets.map((x) => x.file),
          file: targets[0].file,
          rel: targets[0].rel,
          name: baseName(targets[0].file).replace(/\.[^.]+$/, ''),
          folder: dirName(targets[0].file),
          project,
        },
        style,
      ),
    ]
  return targets.map((x) =>
    fillCommand(
      command,
      {
        file: x.file,
        files: [x.file],
        rel: x.rel,
        name: baseName(x.file).replace(/\.[^.]+$/, ''),
        folder: dirName(x.file),
        project,
      },
      style,
    ),
  )
}

/** 执行时一行一行推给页面的消息 */
export type ExportEvent =
  | { type: 'start'; line: string; index: number; total: number }
  | { type: 'out'; text: string }
  | { type: 'end'; index: number; code: number | null; killed?: string; error?: string }
  | { type: 'done'; ok: boolean }

/** 输出里一处能点的位置：哪张表、哪一格（行列从 0 数；只给了文件时是 undefined） */
export interface OutputLoc {
  path: string
  sheet?: string
  row?: number
  col?: number
}

const FILE_RE = /([^\s"'()[\]<>]+\.(?:xlsx|xlsm|csv|tsv))(?::(\d+)(?::(\d+))?)?/gi
const CELL_RE = /([\p{L}\p{N}_]+)!([A-Z]{1,3})(\d+)/gu

const colOf = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

/**
 * 导表输出的一行切成几段，认出来的位置带上 loc（点了跳过去）：
 * 「路径.xlsx:行:列」「路径.xlsx」按项目里的表格文件对（绝对路径、反斜杠都行，按结尾对）；
 * 「Sheet!A1」只有一张表在导时算这张表的
 */
export function outputLocs(line: string, files: string[], only?: string): { text: string; loc?: OutputLoc }[] {
  const found: { at: number; end: number; loc: OutputLoc }[] = []
  const fileOf = (p: string) => {
    const n = p.replace(/\\/g, '/')
    return files.find((f) => n === f || n.endsWith(`/${f}`))
  }
  for (const m of line.matchAll(FILE_RE)) {
    const path = fileOf(m[1])
    if (!path) continue
    found.push({
      at: m.index,
      end: m.index + m[0].length,
      loc: {
        path,
        ...(m[2] ? { row: Number(m[2]) - 1 } : {}),
        ...(m[3] ? { col: Number(m[3]) - 1 } : {}),
      },
    })
  }
  if (only)
    for (const m of line.matchAll(CELL_RE)) {
      if (found.some((f) => m.index < f.end && m.index + m[0].length > f.at)) continue
      found.push({
        at: m.index,
        end: m.index + m[0].length,
        loc: { path: only, sheet: m[1], row: Number(m[3]) - 1, col: colOf(m[2]) },
      })
    }
  if (!found.length) return [{ text: line }]
  found.sort((a, b) => a.at - b.at)
  const out: { text: string; loc?: OutputLoc }[] = []
  let i = 0
  for (const f of found) {
    if (f.at < i) continue
    if (f.at > i) out.push({ text: line.slice(i, f.at) })
    out.push({ text: line.slice(f.at, f.end), loc: f.loc })
    i = f.end
  }
  if (i < line.length) out.push({ text: line.slice(i) })
  return out
}
