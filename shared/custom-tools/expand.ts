/**
 * 自建工具的参数校验和命令展开：参数值按目标 shell 的规则加引号，不做字符串拼接（设计稿第 3 节）。
 * 服务端执行、管理页试运行、演示后端都调这一份。错误文字会原样交给 Agent 和用户，写清楚怎么改
 */
import type { ShellKind } from '../shells.ts'
import type { CustomTool, ToolParam } from './schema.ts'

/** 面板自带的占位符 */
export const BUILTIN_VARS = ['projectRoot', 'workDir', 'docRoot', 'dataDir', 'script'] as const
export type BuiltinVars = Partial<Record<(typeof BUILTIN_VARS)[number], string>>

const SAFE = /^[A-Za-z0-9_@%+=:,./\\-]+$/

/** 按 shell 给一个值加引号；返回 null 表示这个值在这个 shell 里没法安全传（理由由调用方说） */
export function quoteFor(shell: ShellKind, v: string): string | null {
  if (/[\r\n\0]/.test(v)) return null
  if (shell === 'cmd') {
    // cmd 的双引号里 % 会展开、" 会提前结束引号，没有可靠的转义：直接拒绝
    if (/["%]/.test(v)) return null
    return SAFE.test(v) && !v.includes('%') ? v : `"${v}"`
  }
  if (SAFE.test(v)) return v
  // PowerShell 单引号里只有 ' 要写成 ''；sh 系的单引号里什么都不展开，' 用 '\'' 断开
  if (shell === 'powershell') return `'${v.replaceAll("'", "''")}'`
  return `'${v.replaceAll("'", `'\\''`)}'`
}

/** 参数值的展示文字（授权卡、运行记录） */
export const showValue = (v: unknown) => (v === undefined || v === '' ? '—' : String(v))

/** 一组参数校验后的结果：values 已按类型转好、补了默认值 */
export interface CheckedArgs {
  values: Record<string, string | number | boolean | undefined>
  errors: string[]
}

const toBool = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1'

/** 按参数定义校验 Agent 或表单传来的参数：未知参数报错（拼错的条件被悄悄忽略比报错更糟） */
export function checkArgs(
  tool: Pick<CustomTool, 'params'>,
  args: Record<string, unknown> | undefined,
  root?: string,
): CheckedArgs {
  const a = args ?? {}
  const errors: string[] = []
  const values: CheckedArgs['values'] = {}
  const names = new Set(tool.params.map((p) => p.name))
  for (const k of Object.keys(a))
    if (!names.has(k))
      errors.push(`没有参数 ${k}：这个工具的参数是 ${tool.params.map((p) => p.name).join('、') || '（没有参数）'}`)
  for (const p of tool.params) values[p.name] = checkOne(p, a[p.name], errors, root)
  return { values, errors }
}

function checkOne(p: ToolParam, raw: unknown, errors: string[], root?: string) {
  const name = p.label ? `${p.name}（${p.label}）` : p.name
  const given = raw !== undefined && raw !== null && raw !== ''
  const v = given ? raw : p.default
  if (v === undefined || v === '') {
    if (p.required) errors.push(`缺参数 ${name}${p.desc ? `：${p.desc}` : ''}`)
    return undefined
  }
  if (p.type === 'boolean') return toBool(v)
  if (p.type === 'number') {
    const n = typeof v === 'number' ? v : Number(String(v).trim())
    if (!Number.isFinite(n)) {
      errors.push(`${name} 要填数字，收到「${String(v)}」`)
      return undefined
    }
    if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max))
      errors.push(`${name} 要在 ${p.min ?? '-∞'} 到 ${p.max ?? '∞'} 之间，收到 ${n}`)
    return n
  }
  const s = String(v)
  if (/[\r\n\0]/.test(s)) {
    errors.push(`${name} 的值里不能有换行`)
    return undefined
  }
  if (p.type === 'enum' && p.options.length && !p.options.includes(s)) {
    errors.push(`${name} 只能是 ${p.options.join(' / ')}，收到「${s}」`)
    return undefined
  }
  if (p.pattern && !safeRegex(p.pattern)?.test(s))
    errors.push(`${name} 的格式不对（要匹配 ${p.pattern}），收到「${s}」`)
  if (p.type === 'path' && p.inProject && root && !insideRoot(root, s))
    errors.push(`${name} 要在项目目录里，收到「${s}」`)
  return s
}

/** 路径在不在项目里：前后端都要用，不依赖 node:path（绝对路径比前缀，相对路径数 ..） */
export function insideRoot(root: string, p: string): boolean {
  const norm = (x: string) => x.replaceAll('\\', '/').replace(/\/+$/, '')
  const v = norm(p)
  if (/^([A-Za-z]:)?\//.test(v)) {
    const r = norm(root)
    const win = /^[A-Za-z]:/.test(r)
    const [a, b] = win ? [v.toLowerCase(), r.toLowerCase()] : [v, r]
    return a === b || a.startsWith(`${b}/`)
  }
  let depth = 0
  for (const seg of v.split('/')) {
    if (!seg || seg === '.') continue
    depth += seg === '..' ? -1 : 1
    if (depth < 0) return false
  }
  return true
}

const safeRegex = (src: string) => {
  try {
    return new RegExp(src)
  } catch {
    return undefined
  }
}

/** 这个平台用哪条命令模板 */
export const commandTemplate = (tool: Pick<CustomTool, 'run'>, platform: string) =>
  (platform === 'win32' ? tool.run.win : tool.run.posix) || tool.run.command

/**
 * 展开命令：{{参数}} 换成加好引号的值（带 flag 的连同 flag，空值和假值整个去掉），{{内置}} 换成路径。
 * 返回 error 时不要执行
 */
export function expandCommand(
  template: string,
  tool: Pick<CustomTool, 'params'>,
  values: CheckedArgs['values'],
  shell: ShellKind,
  vars: BuiltinVars,
): { line: string; error?: string } {
  const byName = new Map(tool.params.map((p) => [p.name, p]))
  const errors: string[] = []
  // 展开后的值先放一边、模板里留占位，收多余空格时不碰值本身（值里的连续空格要原样传）
  const subs: string[] = []
  const hold = (v: string) => (v ? `\u0000${subs.push(v) - 1}\u0000` : '')
  const line = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => hold(one(key)))
  function one(key: string): string {
    if ((BUILTIN_VARS as readonly string[]).includes(key)) {
      const v = vars[key as keyof BuiltinVars]
      if (v === undefined) {
        errors.push(`{{${key}}} 在这里没有值（${key === 'script' ? '工具没写脚本正文' : '不在项目里'}）`)
        return ''
      }
      return quoteFor(shell, v) ?? (errors.push(`路径 ${v} 在 ${shell} 里没法安全传`), '')
    }
    const p = byName.get(key)
    if (!p) {
      errors.push(`命令里的 {{${key}}} 不是参数，也不是面板自带的占位符（${BUILTIN_VARS.join('、')}）`)
      return ''
    }
    const v = values[key]
    if (v === undefined || v === false || v === '') return ''
    if (v === true) return p.flag ?? ''
    const q = quoteFor(shell, String(v))
    if (q === null) {
      errors.push(`${key} 的值「${String(v)}」在 ${shell} 里没法安全传（cmd 不能带 " 和 %，任何 shell 都不能带换行）`)
      return ''
    }
    return p.flag ? `${p.flag} ${q}` : q
  }
  // 去掉的参数留下的多余空格收一收，再把值放回去
  const tidy = line
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    // oxlint-disable-next-line no-control-regex -- 占位用的 \u0000 是上面自己放的，值里不可能有（quoteFor 拒绝 \0）
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => subs[Number(i)])
  return errors.length ? { line: tidy, error: errors.join('；') } : { line: tidy }
}

/** 草稿本身的问题（保存前查）：占位符对不上参数、参数重名、正则写错 */
export function draftProblems(tool: Pick<CustomTool, 'params' | 'run' | 'output'>): string[] {
  const out: string[] = []
  const names = tool.params.map((p) => p.name)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length) out.push(`参数重名：${[...new Set(dup)].join('、')}`)
  for (const tpl of [tool.run.command, tool.run.win, tool.run.posix].filter(Boolean) as string[])
    for (const m of tpl.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      const k = m[1]
      if (!names.includes(k) && !(BUILTIN_VARS as readonly string[]).includes(k)) out.push(`命令里的 {{${k}}} 不是参数`)
      if (k === 'script' && !tool.run.script) out.push('命令里用了 {{script}}，但没写脚本正文')
    }
  for (const p of tool.params) {
    if (p.pattern && !safeRegex(p.pattern)) out.push(`参数 ${p.name} 的格式正则写错了：${p.pattern}`)
    if (p.type === 'enum' && !p.options.length) out.push(`参数 ${p.name} 是选项，但没写可选值`)
  }
  if (tool.output.errorPattern && !safeRegex(tool.output.errorPattern))
    out.push(`报错格式的正则写错了：${tool.output.errorPattern}`)
  return [...new Set(out)]
}
