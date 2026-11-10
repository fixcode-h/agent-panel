import type { ToolUse } from './schema.ts'

/**
 * 经验学习的第一、二步（设计稿 §6.2、§6.3）：只看工具调用算出这次绕了多少路，判断值不值得花一次模型提炼。
 * 都是纯函数、不花 token；工具调用已经按 ToolUse.kind 归一化（各 CLI 一样），不按 CLI 名字分支。
 * 不读模型回复的文字（ADR 0041、0049）。
 */

/** 一次工具调用，带上它属于哪个对话（顶层对话和子对话的工作目录不同，路径要各自换成相对项目根的） */
export interface TraceTool {
  tool: Pick<ToolUse, 'kind' | 'label' | 'failed' | 'exitCode' | 'name'>
  /** 这个对话的工作目录前缀（独立分支的 worktree 或项目目录），用来把绝对路径换成相对路径 */
  roots: string[]
}

export interface ExperienceDigest {
  /** 搜索词（Grep / Glob / rg / find…） */
  searches: string[]
  /** 读过的文件（相对项目根） */
  reads: string[]
  /** 改过的文件 */
  edits: string[]
  /** 落点目录：改过的文件（没改过就是最后读的几个）集中在哪 1～2 个目录 */
  landing: string[]
  /** 落点覆盖了多少比例的改动 / 最后的读取 */
  coverage: number
  /** 进入落点目录之前的搜索 + 读取次数 */
  detour: number
  /** 失败后才试成功的命令：最后成功的那条和之前失败了几次 */
  commands: { command: string; failures: number }[]
}

const SEARCH_CMD =
  /^(rg|grep|egrep|findstr|find|fd|ls|dir|tree|ag|ack|git\s+grep|git\s+ls-files|get-childitem|select-string|gci|sls)\b/i

const norm = (p: string) => p.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** 绝对路径换成相对项目根的；不在任何一个根下的原样（规范化后）返回 */
export function relPath(p: string, roots: string[]) {
  const x = norm(p)
  for (const r of roots.map(norm).filter(Boolean)) {
    // Windows 盘符路径不分大小写（shared 里不读 process.platform：浏览器也会加载这个文件）
    const win = /^[a-z]:\//i.test(r)
    const a = win ? x.toLowerCase() : x
    const b = win ? r.toLowerCase() : r
    if (a === b) return ''
    if (a.startsWith(`${b}/`)) return x.slice(r.length + 1)
  }
  return x
}

const dirOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')
/** 目录取前几级当分组：太深了每个文件一个组，太浅了整个 Source 一个组 */
const groupOf = (dir: string, depth = 3) => dir.split('/').filter(Boolean).slice(0, depth).join('/')
const inside = (f: string, dir: string) => !!dir && (f === dir || f.startsWith(`${dir}/`))

/** 命令的「目的」：程序名加第一个参数，同一个目的的多次尝试算一组 */
const commandKey = (c: string) =>
  c
    .trim()
    .replace(/^(cd\s+\S+\s*(&&|;)\s*)+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
    .toLowerCase()

export function digestOf(trace: TraceTool[]): ExperienceDigest {
  const searches: string[] = []
  const reads: string[] = []
  const edits: string[] = []
  // 按顺序记每一步是搜索还是读了哪个文件：算「进落点之前绕了几步」要用
  const steps: { kind: 'search' | 'read'; file: string }[] = []
  const tries = new Map<string, { last: string; failures: number; ok: boolean }>()
  for (const { tool, roots } of trace) {
    const label = (tool.label ?? '').trim()
    if (!label) continue
    const failed = !!tool.failed || (tool.exitCode !== undefined && tool.exitCode !== 0)
    if (tool.kind === 'search') {
      searches.push(label)
      steps.push({ kind: 'search', file: '' })
    } else if (tool.kind === 'read') {
      const f = relPath(label, roots)
      reads.push(f)
      steps.push({ kind: 'read', file: f })
    } else if (tool.kind === 'edit') {
      edits.push(relPath(label, roots))
    } else if (tool.kind === 'run') {
      if (SEARCH_CMD.test(label)) {
        searches.push(label)
        steps.push({ kind: 'search', file: '' })
        continue
      }
      const key = commandKey(label)
      const cur = tries.get(key) ?? { last: label, failures: 0, ok: false }
      if (failed) cur.failures++
      else if (cur.failures) cur.ok = true
      cur.last = label
      tries.set(key, cur)
    }
  }
  // 落点：改过的文件；只查没改的对话（用户说的「找东西」）用最后读的几个文件
  const targets = edits.length ? edits : reads.slice(-5)
  const groups = new Map<string, number>()
  for (const f of targets) {
    const g = groupOf(dirOf(f))
    if (g) groups.set(g, (groups.get(g) ?? 0) + 1)
  }
  const landing = [...groups]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([g]) => g)
  const covered = targets.filter((f) => landing.some((d) => inside(f, d))).length
  const coverage = targets.length ? covered / targets.length : 0
  let detour = 0
  for (const s of steps) {
    if (s.kind === 'read' && landing.some((d) => inside(s.file, d))) break
    detour++
  }
  const commands = [...tries.values()]
    .filter((x) => x.ok && x.failures > 0)
    .map((x) => ({ command: x.last.slice(0, 300), failures: x.failures }))
  return { searches, reads, edits, landing, coverage, detour, commands }
}

/** 三档：绕了多少步才算「绕路明显」；命令失败几次才算试错 */
export const GATE = {
  low: { detour: 12, failures: 3 },
  normal: { detour: 8, failures: 2 },
  high: { detour: 5, failures: 2 },
} as const

export type GateLevel = keyof typeof GATE

/**
 * 值不值得提炼：绕路明显且落点集中，或者命令试错过。返回原因（给运行日志和界面看），不值得时返回空
 */
export function gateReason(d: ExperienceDigest, level: GateLevel = 'normal'): string {
  const g = GATE[level]
  if (d.landing.length && d.coverage >= 0.7 && d.detour >= g.detour)
    return `进入 ${d.landing.join('、')} 之前搜了 / 读了 ${d.detour} 次`
  const tried = d.commands.filter((c) => c.failures >= g.failures)
  if (tried.length) return `命令失败 ${tried[0].failures} 次后才试成功：${tried[0].command.slice(0, 80)}`
  return ''
}

/** 已有经验已经覆盖这次的落点：路径前缀包含落点目录，就不用再学一遍 */
export function landingCovered(d: ExperienceDigest, paths: string[]) {
  if (!d.landing.length) return false
  const bases = paths.map((p) => norm(p).replace(/\/?\*.*$/, ''))
  return d.landing.every((l) => bases.some((b) => !!b && (l === b || l.startsWith(`${b}/`))))
}

/** 交给模型的摘要：只放事实，截短，控制在约 3k token 以内 */
export function digestText(d: ExperienceDigest, reason: string) {
  const uniq = (xs: string[], n: number) => [...new Set(xs)].slice(-n)
  return [
    `值得学的原因：${reason}`,
    `落点目录：${d.landing.join('、') || '（无）'}（覆盖 ${Math.round(d.coverage * 100)}%）`,
    `搜索词（${d.searches.length} 次，列最近 25 个）：\n${uniq(d.searches, 25)
      .map((s) => `- ${s.slice(0, 120)}`)
      .join('\n')}`,
    `读过的文件（${d.reads.length} 次，列最近 25 个）：\n${uniq(d.reads, 25)
      .map((s) => `- ${s}`)
      .join('\n')}`,
    d.edits.length
      ? `改过的文件：\n${uniq(d.edits, 20)
          .map((s) => `- ${s}`)
          .join('\n')}`
      : '没有改文件（只查找）',
    d.commands.length
      ? `试错后成功的命令：\n${d.commands
          .slice(0, 5)
          .map((c) => `- ${c.command}（之前失败 ${c.failures} 次）`)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
