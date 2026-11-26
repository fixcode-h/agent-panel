/**
 * Agent 自己拼的命令是不是在做某个自建工具做的事：按命令里的「程序名」认，不看回复文字（ADR 0041、0049）。
 *
 * 为什么：用户用 /createtool 做了 Lua 检查工具，Agent 写完 Lua 还是自己跑 `luac -p`（2026-11-26）。
 * 提示词里那一行清单不一定被注意到，到它真的要跑同一个程序的那一刻再提醒一次（情境规则 shared/hooks/situational.ts）。
 *
 * 程序名：命令第一个词的文件名（去掉 .exe 这类后缀）；第一个词是解释器（python、node、cmd、powershell……）时取它跑的脚本文件名。
 * 拿不准的（第一个词是占位符、只用面板写出的 {{script}}）不认，宁可漏提醒也不乱提醒
 */
import type { CustomTool, ToolEffect, ToolEntry, ToolRole } from './schema.ts'
import { usable } from './text.ts'

/** 只是用来跑别的脚本的程序：认它后面那个脚本 */
// 模块状态：常量，加载后不改
const INTERPRETERS = new Set([
  'python',
  'python3',
  'py',
  'node',
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'call',
  'start',
  'lua',
  'luajit',
])

export interface CustomToolSig {
  id: string
  name: string
  /** 小写的程序名或脚本文件名 */
  sigs: string[]
  /** 用途（ADR 0086）：校验、编译；不写是普通工具 */
  role?: ToolRole['kind']
  /** verify：改了哪些文件要跑它 */
  paths?: string[]
  /** 认作同一件事的别的程序（luac 这类）：Agent 自己跑它们时也算在做这个工具的事 */
  replaces?: string[]
  effect?: ToolEffect
  /** 改过的文件填进哪个参数（没有就是不带文件跑） */
  fileParam?: string
  /** 除了文件参数还有必填、又没默认值的参数：面板替它跑时填不上，只能让 Agent 自己调 */
  needsArgs?: boolean
}

const base = (word: string) =>
  word
    .replace(/^["']|["']$/g, '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, '')

/** 一条命令的程序名（拿不准时为空串） */
export function programOf(cmd: string): string {
  const words = cmd.trim().split(/\s+/).filter(Boolean)
  for (const w of words) {
    if (w.includes('{{')) return ''
    if (w.startsWith('-') || (w.startsWith('/') && w.length <= 3)) continue
    const b = base(w)
    if (!b) return ''
    if (!INTERPRETERS.has(b)) return b
  }
  return ''
}

/** 每个能用的自建工具认得出的程序名（Windows / 其他系统的写法都算） */
export function customToolSigs(entries: ToolEntry[]): CustomToolSig[] {
  return usable(entries).flatMap((e) => {
    const t = e.tool!
    const sigs = [...new Set([t.run.command, t.run.win, t.run.posix].flatMap((c) => (c ? [programOf(c)] : [])))].filter(
      (s) => s.length >= 3,
    )
    const replaces = (t.role?.replaces ?? []).map(base).filter(Boolean)
    if (!sigs.length && !replaces.length) return []
    return [{ id: t.id, name: t.name, sigs, ...roleSig(t, replaces) }]
  })
}

/** 改过的文件填进哪个参数：role.arg，没写时第一个 path 类型的参数 */
export const fileParamOf = (t: Pick<CustomTool, 'params' | 'role'>) =>
  (t.role?.arg && t.params.some((p) => p.name === t.role!.arg) ? t.role.arg : undefined) ??
  t.params.find((p) => p.type === 'path')?.name

function roleSig(t: CustomTool, replaces: string[]): Partial<CustomToolSig> {
  const fileParam = fileParamOf(t)
  const needsArgs = t.params.some((p) => p.name !== fileParam && p.required && p.default === undefined)
  return {
    effect: t.effect,
    ...(t.role ? { role: t.role.kind, paths: t.role.paths } : {}),
    ...(replaces.length ? { replaces } : {}),
    ...(fileParam ? { fileParam } : {}),
    ...(needsArgs ? { needsArgs } : {}),
  }
}

/** 这个工具认不认这个程序名：自己的命令里的程序，或 role.replaces 里登记的 */
export const sigMatches = (t: Pick<CustomToolSig, 'sigs' | 'replaces'>, prog: string) =>
  !!prog && (t.sigs.includes(prog) || !!t.replaces?.includes(prog))

/** 这条命令在做的事有对应的自建工具：按命令里出现的程序名或脚本名认 */
export function customToolFor(command: string, tools: CustomToolSig[]): CustomToolSig | undefined {
  const words = new Set(
    command
      .split(/[\s;&|()]+/)
      .filter(Boolean)
      .map(base),
  )
  return tools.find((t) => [...t.sigs, ...(t.replaces ?? [])].some((s) => words.has(s)))
}
