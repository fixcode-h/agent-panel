/**
 * 自建工具交给 Agent 的文字：提示词里那一行清单、list / show 的结果、一次运行的结果。
 * 都是提示词，不翻译；长度按 ADR 0067（默认不超过 4000 字）
 */
import { HINT_MAX_TOOLS, type CustomTool, type ToolEntry } from './schema.ts'

const EFFECT: Record<CustomTool['effect'], string> = { read: '只读', write: '会改文件', external: '影响外部' }
const SCOPE = { project: '项目', global: '全局' } as const

/** 能用的工具：读得进来、没被项目里同 id 的盖住 */
export const usable = (entries: ToolEntry[]) => entries.filter((e) => e.tool && !e.shadowed)

const paramBrief = (t: CustomTool) =>
  t.params.length
    ? t.params.map((p) => `${p.name}${p.required ? '' : '?'}${p.label ? `（${p.label}）` : ''}`).join(' ')
    : '无参数'

/** 提示词里的清单：按最近用过的排，最多 8 行、600 字；一个都没有时是空串 */
export function hintText(entries: ToolEntry[]): string {
  const list = usable(entries).sort((a, b) => (b.last?.at ?? '').localeCompare(a.last?.at ?? ''))
  if (!list.length) return ''
  const lines: string[] = []
  let size = 0
  for (const e of list.slice(0, HINT_MAX_TOOLS)) {
    const t = e.tool!
    // 顶替哪些程序也写上（ADR 0086）：Agent 一开始就知道该用它而不是自己拼 luac，不用等面板代答一次才知道
    const rep = t.role?.replaces.length ? `（代替 ${t.role.replaces.join('、')}）` : ''
    const l = `${t.name} ${t.id}${rep}：${(t.useWhen || t.summary).slice(0, 60)}`
    if (size + l.length > 600) break
    lines.push(l)
    size += l.length
  }
  const more = list.length - lines.length
  return (
    `项目的自建工具（要做的事和下面某个对得上时用 custom_tool 调它，不要自己拼命令；参数不清楚先 action=show）：${lines.join('；')}` +
    (more > 0 ? `；还有 ${more} 个，action=list 看全部` : '') +
    '；'
  )
}

/** action=list：一行一个 */
export function listText(entries: ToolEntry[], query = ''): string {
  const q = query.trim().toLowerCase()
  const bad = entries.filter((e) => e.error)
  const hits = usable(entries).filter((e) => {
    if (!q) return true
    const t = e.tool!
    return [t.id, t.name, t.summary, t.useWhen, ...t.tags].join(' ').toLowerCase().includes(q)
  })
  if (!hits.length && !bad.length)
    return q
      ? `没有和「${query}」相关的自建工具。可以用 /createtool 把要做的事做成工具。`
      : '还没有自建工具。用户可以用 /createtool 把常用命令做成工具。'
  const lines = hits.map((e) => {
    const t = e.tool!
    return `- ${t.id}「${t.name}」[${SCOPE[e.scope]} · ${EFFECT[t.effect]} · v${t.version}] ${t.useWhen || t.summary}｜参数：${paramBrief(t)}`
  })
  if (bad.length) lines.push(`（${bad.length} 个工具文件读不进来，用户在「技能与 MCP → 工具」里能看到原因）`)
  return clipText(lines.join('\n'), 4000)
}

/** action=show：完整定义（不含历史） */
export function showText(e: ToolEntry): string {
  const t = e.tool!
  const params = t.params.map(
    (p) =>
      `  - ${p.name}${p.required ? '（必填）' : ''}：${p.label || ''} ${p.type}${p.type === 'enum' ? `[${p.options.join('/')}]` : ''}` +
      `${p.default !== undefined ? ` 默认 ${String(p.default)}` : ''}${p.flag ? ` 写成 ${p.flag}` : ''}${p.desc ? ` — ${p.desc}` : ''}`,
  )
  return clipText(
    [
      `${t.id}「${t.name}」 ${SCOPE[e.scope]} · v${t.version} · ${EFFECT[t.effect]}`,
      t.summary && `说明：${t.summary}`,
      t.useWhen && `什么时候用：${t.useWhen}`,
      t.avoidWhen && `什么时候别用：${t.avoidWhen}`,
      `参数：${t.params.length ? '' : '无'}`,
      ...params,
      `命令：${t.run.command}`,
      t.run.win && `Windows 上：${t.run.win}`,
      t.run.posix && `其他系统上：${t.run.posix}`,
      t.run.script && `脚本（.${t.run.script.ext}，${t.run.script.text.split('\n').length} 行）`,
      `目录：${t.run.cwd} · 限时 ${t.run.timeoutSec} 秒`,
      t.writes.length && `会改：${t.writes.join('、')}`,
      t.role && roleText(t.role),
      `调用：custom_tool action=run id=${t.id} args={${t.params.map((p) => `"${p.name}": …`).join(', ')}}`,
    ]
      .filter(Boolean)
      .join('\n'),
    4000,
  )
}

/** show 里的用途一行：Agent 要知道改完这些文件面板会自己跑它，不用再手动跑 */
function roleText(r: NonNullable<CustomTool['role']>) {
  const rep = r.replaces.length ? `；顶替 ${r.replaces.join('、')}` : ''
  return r.kind === 'verify'
    ? `用途：校验（改完 ${r.paths.join('、') || '对得上的文件'} 后面板自己跑，只推报错${rep}）`
    : `用途：编译${rep}`
}

export function clipText(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n…（截断，共 ${s.length} 字）`
}

/** 一次运行的结果（工具里等到的那种） */
export interface ToolRunResult {
  ok: boolean
  code: number | null
  ms: number
  /** 实际跑的命令 */
  line: string
  /** 解析出的报错 */
  errors: { file?: string; line?: number; msg: string }[]
  /** 输出最后几行 */
  tail: string[]
  totalLines: number
  logFile?: string
  /** 签出的文件或签出失败的原因 */
  checkout?: string
  /** 这次运行在版本管理里改了哪些文件、加减多少行（大量删除时带告警）；没改或不是 git / P4 项目时不带 */
  changes?: string
  timedOut?: boolean
  /** 没跑起来 */
  spawnError?: string
}

/** 按报错正则从输出里挑报错行，最多 30 条 */
export function parseErrors(lines: string[], pattern?: string) {
  if (!pattern) return []
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch {
    return []
  }
  const out: ToolRunResult['errors'] = []
  for (const l of lines) {
    const m = re.exec(l)
    if (!m) continue
    const g = m.groups ?? {}
    out.push({
      ...(g.file ? { file: g.file } : {}),
      ...(g.line && Number(g.line) ? { line: Number(g.line) } : {}),
      msg: (g.msg ?? l).trim(),
    })
    if (out.length >= 30) break
  }
  return out
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** 交给 Agent 的运行结果：退出码、报错、尾部、日志路径、下一步 */
export function runText(t: Pick<CustomTool, 'id' | 'name'>, r: ToolRunResult): string {
  const head = `${t.name} ${t.id} · ${r.spawnError ? '没跑起来' : `退出码 ${r.code ?? '无'}`} · ${sec(r.ms)} · ${r.ok ? '成功' : '失败'}${r.timedOut ? '（超过限时，面板已停止）' : ''}`
  const parts = [head, `命令：${r.line}`]
  if (r.spawnError) parts.push(`原因：${r.spawnError}`)
  // 改动摘要放在输出尾部前面：结果超长被截时也不丢（大量删除的告警最要紧）
  if (r.changes) parts.push(r.changes)
  if (r.errors.length)
    parts.push(
      `报错 ${r.errors.length} 处：\n` +
        r.errors.map((e) => `  ${e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : ''}${e.msg}`).join('\n'),
    )
  if (r.tail.length) parts.push(`输出最后 ${r.tail.length} 行：\n${r.tail.join('\n')}`)
  if (r.logFile) parts.push(`完整日志：${r.logFile}（${r.totalLines} 行）`)
  if (r.checkout) parts.push(r.checkout)
  if (!r.ok)
    parts.push(
      r.timedOut
        ? '下一步：确认是不是卡住了；确实要跑很久就让用户在工具设置里调大限时或改成后台。'
        : '下一步：按报错改好后用同样的参数再跑一次；看不懂原因就读完整日志，不要换成自己拼的命令绕开。',
    )
  return clipText(parts.join('\n'), 4000)
}

/** 「/」菜单里的自建工具发出去的名字：tool:<id> */
export const TOOL_COMMAND_PREFIX = 'tool:'

/** 用户在「/」菜单里选了自建工具：展开成让 Agent 照参数跑它的要求（仍由 Agent 跑，出错了它能接着处理） */
export function toolCommandPrompt(id: string, args: string) {
  return (
    `用户用 /${TOOL_COMMAND_PREFIX}${id} 要你运行自建工具 ${id}：先用 custom_tool action=show id=${id} 看参数，按用户下面的话填参数（没说的用默认值，必填的说不清就问），再用 action=run 执行；` +
    '失败了按报错处理，不要换成自己拼的命令绕开。最后用一两句说明结果。' +
    (args ? `\n\n## 用户的话\n${args}` : '')
  )
}
