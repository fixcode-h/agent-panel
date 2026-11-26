/**
 * 技能的触发条件 SkillWhen（设计稿《技能由面板推送》3.2）：面板判断「这个 Agent 现在需不需要这个技能」只看这些，
 * 对上了就把正文推给它。只看工具调用、面板状态、用户自己发的消息和附件、节点参数，不看模型回复（ADR 0041、0049）。
 *
 * 一条条件只有 kind + value 两个字段，设置页一行一个下拉加一个输入框就能改；一个技能可以写几条，任意一条对上就推。
 * - edit / read：要改 / 读的文件对得上通配（相对、绝对、Windows 路径都认），例如 `**\/*.lua`
 * - command：跑的命令属于某一类（vcs / vcs-write / test / build / search，见 ./commands.ts）或者就是某个程序，多个用 | 分开
 * - tool：调了某个工具（去掉 MCP 前缀的名字），通配，例如 `blender_*`
 * - failed：某类命令失败之后（值同 command）
 * - phase：面板状态。finishing = 调收尾工具（end_turn、submit_*）时；finishing-edited = 同上且这个对话改过文件；
 *   bug = Bug 模式开跑
 * - project：开跑时项目根目录下有对得上通配的文件，例如 `*.uproject`
 * - message：开跑时用户这条消息里写到的路径、附件对得上通配
 * - params：开跑时角色 / 节点参数取值，`键=值`，几个值用 | 分开，例如 `lang=lua`
 */
import { globRe } from '../text-match/index.ts'
import { commandMatches } from './commands.ts'
import type { SkillWhen } from './schema.ts'

export { SKILL_PHASES, SKILL_WHEN_KINDS, SkillWhen, type SkillWhenKind } from './schema.ts'

/** 什么时候判断：工具前、工具后（失败）、开跑时 */
export type SkillMoment = 'tool.before' | 'tool.after' | 'launch'

export const whenMoment = (w: SkillWhen): SkillMoment =>
  w.kind === 'failed'
    ? 'tool.after'
    : w.kind === 'project' || w.kind === 'message' || w.kind === 'params' || (w.kind === 'phase' && w.value === 'bug')
      ? 'launch'
      : 'tool.before'

/** 收尾工具：调它们就是 Agent 要交卷了 */
const FINISHING = /^(end_turn|submit_[a-z_]+)$/

/** 工具调用上判断要用的事实（server 从钩子事实里取，测试直接给） */
export interface SkillCallFacts {
  kind: 'shell' | 'edit' | 'read' | 'panel' | 'any'
  /** 去掉 MCP 前缀后的工具名；面板工具是去掉前缀的面板名 */
  tool: string
  /** 要改 / 读的文件 */
  paths: string[]
  /** 跑命令时的命令原文 */
  command: string
  /** 工具后才有：这次失败了 */
  failed?: boolean
  /** 这个对话改过文件（finishing-edited 用） */
  edited?: boolean
}

/** 开跑时判断要用的事实 */
export interface SkillLaunchFacts {
  /** 项目根目录下的文件名（只一层） */
  projectFiles: string[]
  /** 用户这条消息里写到的路径和附件 */
  messagePaths: string[]
  params: Record<string, unknown>
  /** 这一轮是 Bug 模式 */
  bug: boolean
}

const globs = (v: string) =>
  v
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((g) => globRe(g, { dirPrefix: true }))
const anyPath = (v: string, files: string[]) => {
  const res = globs(v)
  return files.some((p) => {
    const f = p.replace(/\\/g, '/')
    return !!f && res.some((re) => re.test(f))
  })
}

/** 这条条件在这次工具调用上对不对得上 */
export function whenMatchesCall(w: SkillWhen, f: SkillCallFacts, moment: 'tool.before' | 'tool.after'): boolean {
  if (whenMoment(w) !== moment) return false
  switch (w.kind) {
    case 'edit':
      return f.kind === 'edit' && anyPath(w.value, f.paths)
    case 'read':
      return f.kind === 'read' && anyPath(w.value, f.paths)
    case 'command':
      return f.kind === 'shell' && commandMatches(w.value, f.command)
    case 'tool':
      return !!f.tool && globs(w.value).some((re) => re.test(f.tool))
    case 'failed':
      return f.kind === 'shell' && f.failed === true && commandMatches(w.value, f.command)
    case 'phase':
      if (!FINISHING.test(f.tool)) return false
      return w.value === 'finishing' || (w.value === 'finishing-edited' && !!f.edited)
    default:
      return false
  }
}

/** params 条件：`键=值1|值2` */
function paramsMatch(v: string, params: Record<string, unknown>) {
  const at = v.indexOf('=')
  if (at <= 0) return false
  const key = v.slice(0, at).trim()
  const want = v
    .slice(at + 1)
    .split('|')
    .map((x) => x.trim())
  const got = params[key]
  const vals = Array.isArray(got) ? got.map(String) : got === undefined || got === null ? [] : [String(got)]
  return vals.some((x) => want.includes(x))
}

/** 这条条件开跑时对不对得上 */
export function whenMatchesLaunch(w: SkillWhen, f: SkillLaunchFacts): boolean {
  if (whenMoment(w) !== 'launch') return false
  switch (w.kind) {
    case 'project':
      return anyPath(w.value, f.projectFiles)
    case 'message':
      return anyPath(w.value, f.messagePaths)
    case 'params':
      return paramsMatch(w.value, f.params)
    case 'phase':
      return w.value === 'bug' && f.bug
    default:
      return false
  }
}

/** 推给模型时写的「为什么推」：提示词，不翻译 */
export function whenReason(w: SkillWhen): string {
  switch (w.kind) {
    case 'edit':
      return `要改 ${w.value} 的文件`
    case 'read':
      return `要读 ${w.value} 的文件`
    case 'command':
      return `要跑 ${w.value} 类命令`
    case 'tool':
      return `调了 ${w.value} 工具`
    case 'failed':
      return `${w.value} 类命令失败了`
    case 'phase':
      return w.value === 'bug' ? 'Bug 模式开跑' : '要收尾了'
    case 'project':
      return `项目里有 ${w.value}`
    case 'message':
      return `消息里提到 ${w.value}`
    case 'params':
      return `参数 ${w.value}`
  }
}

/**
 * 消息里写到的路径：带扩展名的词（a/b.lua、C:\x\y.cpp、`Foo.h`）。只认像路径的词，
 * 正文里的普通句子不算
 */
export function pathsInText(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:[A-Za-z]:)?[\w./\\@-]*[\w-]\.[A-Za-z0-9]{1,8}\b/g)) {
    const p = m[0].replace(/^[`'"(]+|[`'"),.;:]+$/g, '')
    if (p.length >= 3 && !/^\d+(\.\d+)+$/.test(p) && !/^https?:/.test(p)) out.add(p)
  }
  return [...out]
}
