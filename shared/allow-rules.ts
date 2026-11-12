import { t } from './i18n.ts'

/**
 * 审批卡上的「这个对话里一直允许这类」（设计报告 Agent P0-3）：以前每次都要点「允许」，同一类命令一遍遍点。
 * 请求带一条规则键（这里生成），用户点了「一直允许」就记进对话的 allowRules，之后同一个对话里同类请求自动允许。
 *
 * 规则故意窄：命令按程序名（多子命令的工具带上子命令，git status 和 git push 不是一回事），
 * 文件按所在目录（含子目录），其他工具按工具名。带管道、串联、重定向、子 shell 的命令和删除、提权这类命令不给规则，
 * 每次都要人看一眼。提问、节点确认不走这里
 */

/** 这些工具的子命令差别大：规则带上第一个子命令 */
// 模块状态：常量，加载后不改
const SUBCOMMAND = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'bun',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'pip',
  'uv',
  'dotnet',
  'gradle',
  'mvn',
])
/** 删除、提权、改权限这类：再常用也每次都问 */
const NEVER = new Set(['rm', 'rmdir', 'del', 'sudo', 'su', 'dd', 'mkfs', 'chmod', 'chown', 'shutdown', 'reboot']) // 模块状态：常量，加载后不改

/** 命令的规则键；不适合一直允许的返回空 */
export function commandRule(cmd: string): string {
  const s = cmd.trim()
  if (!s || /[;&|`$()<>\n]/.test(s)) return ''
  const words = s.split(/\s+/)
  // 开头的环境变量赋值（FOO=1 npm test）不算程序名
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
  const prog = words[i]?.split(/[\\/]/).pop()?.toLowerCase()
  if (!prog || NEVER.has(prog)) return ''
  const sub = words[i + 1]
  return SUBCOMMAND.has(prog) && sub && !sub.startsWith('-') ? `command:${prog} ${sub}` : `command:${prog}`
}

/** 文件的规则键：所在目录（以 / 结尾，匹配时含子目录）；只有文件名时按文件本身 */
export function fileRule(file: string): string {
  const p = file.trim().replace(/\\/g, '/')
  if (!p) return ''
  const at = p.lastIndexOf('/')
  return `file:${at < 0 ? p : p.slice(0, at + 1)}`
}

export const toolRule = (name: string) => (name ? `tool:${name}` : '')

/** 请求的规则命中了对话里记下的哪一条：文件规则按目录前缀，其余要一模一样 */
export function ruleAllowed(rules: readonly string[], rule: string | undefined): boolean {
  if (!rule) return false
  return rules.some((r) => r === rule || (r.startsWith('file:') && r.endsWith('/') && rule.startsWith(r)))
}

/** 规则给人看的说法：按钮「一直允许 …」、自动允许那一行 */
export function ruleText(rule: string): string {
  const [kind, ...rest] = rule.split(':')
  const v = rest.join(':')
  if (kind === 'command') return t('命令 {cmd}', { cmd: v })
  if (kind === 'file') return v.endsWith('/') ? t('目录 {dir} 里的文件', { dir: v }) : t('文件 {file}', { file: v })
  return t('工具 {name}', { name: v })
}

/** diff 最多带这么多行：审批卡只要让人看清改了什么，整份大文件不用全塞进任务记录 */
const DIFF_LINES = 300

const asLines = (s: string) => (s ? s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [])

/**
 * 改文件请求的差异（unified diff 文本，审批卡按行上色）：Claude Code 的 Edit / MultiEdit 给的是要替换的原文和新文，
 * Write 给的是整份新内容。只有替换的那几段，没有前后文和行号
 */
export function editDiff(file: string, edits: { old: string; new: string }[]): string {
  const out = [`--- a/${file}`, `+++ b/${file}`]
  for (const e of edits) {
    out.push('@@')
    for (const l of asLines(e.old)) out.push(`-${l}`)
    for (const l of asLines(e.new)) out.push(`+${l}`)
  }
  if (out.length <= DIFF_LINES) return out.join('\n')
  return [...out.slice(0, DIFF_LINES), t('…（还有 {n} 行没显示）', { n: out.length - DIFF_LINES })].join('\n')
}
