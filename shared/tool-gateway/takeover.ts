/**
 * 查找接管（ADR 0084 第二期）的纯逻辑：哪次调用接、用改写还是代答、交给 find 的请求、面板补的那一段和代答的全文。
 * 服务端（server/tool-gateway/takeover/）只负责真的去查、照原样跑原命令、写打印脚本。
 *
 * 用户 2026-11-26 定的三条：
 * 1. 结果是「面板 + 原命令」的并集，不比原命令少。改写时原命令照样由 CLI 在它自己的 shell 里跑（改写成「先打印面板那段，再跑原命令」），
 *    代答时面板照原样跑一遍原命令、原输出一字不改放进结果，面板只往前面补声明和原命令按原文搜不到的；
 * 2. 拿不准的一律放行：参数认不全、正则、要 shell 展开的通配、多段命令、原命令在面板里跑不出来、面板没有多出来的，都放行；
 * 3. 网关出错放行（服务端兜住）。
 * 补的那段是给 Agent 看的，不翻译
 */
import type { FindHit, FindRequest } from '../capability-router/find/types.ts'
import { inferLang } from '../capability-router/find/request.ts'
import { hitLine } from '../capability-router/find/hits.ts'
import { parseGrepTool, parseSearchCommand, type SearchSpec } from './search-args.ts'
import type { CliTakeover } from './takeover-spec.ts'
import type { ToolCall } from './types.ts'

export type TakeoverPlan =
  { how: 'rewrite' | 'serve'; search: SearchSpec; by: string } | { how: 'pass'; why: string; by: string }

/** 按名字找文件的程序：认出来但不接管（文件索引不收排除目录，只会比原命令少） */
const NAME_FINDERS = ['find', 'fd', 'dir', 'where', 'get-childitem', 'gci']

export const PASS_WHY = {
  multi: '多段命令（管道、&&、;）不改道：拆开改写会改变语义，照原命令跑',
  files: '按名字找文件不改道：文件索引不收排除目录，结果不会比原命令多',
  args: '参数拿不准（不认识的参数、正则、变量、要 shell 展开的通配或读标准输入），照原命令跑',
  cli: '这个 CLI 不能改写命令，面板也没法照原样跑这一条，照原命令跑',
  tool: '这个自带搜索工具没在 CLI 定义里登记形状（takeover.tools），照原样跑',
  noFind: '这个对话不在项目里，没有查找的路',
  nothing: '面板没有多出来的结果（声明、原命令按原文搜不到的都没有），照原命令跑',
  original: '面板没能照原样跑一遍原命令（找不到程序、出错、超时、输出太长或是二进制），照原命令跑',
} as const

/**
 * 这次调用接不接、怎么接；不归查找接管的返回 undefined（网关照旧只推算）。
 * rewriteTpl：钩子定义里有没有改写的输出模板，和 takeover.rewrite 都有才改写
 */
export function planTakeover(
  call: ToolCall,
  o: { takeover: CliTakeover; rewriteTpl: boolean },
): TakeoverPlan | undefined {
  if (call.kind === 'shell' && call.command?.category === 'search') {
    const by = call.command.program
    if (call.command.segments !== 1) return { how: 'pass', why: PASS_WHY.multi, by }
    if (NAME_FINDERS.includes(by)) return { how: 'pass', why: PASS_WHY.files, by }
    const search = parseSearchCommand(String(call.input.command ?? ''))
    if (!search) return { how: 'pass', why: PASS_WHY.args, by }
    if (o.takeover.rewrite && o.rewriteTpl) return { how: 'rewrite', search, by }
    if (o.takeover.serve && search.run) return { how: 'serve', search, by }
    return { how: 'pass', why: PASS_WHY.cli, by }
  }
  if (call.kind === 'read' && call.search) {
    const by = call.tool
    const shape = o.takeover.tools[call.tool]
    if (!shape) return { how: 'pass', why: PASS_WHY.tool, by }
    if (shape === 'glob') return { how: 'pass', why: PASS_WHY.files, by }
    const search = parseGrepTool(call.input)
    if (!search) return { how: 'pass', why: PASS_WHY.args, by }
    // 自带工具换不成 shell 命令：只能代答
    return o.takeover.serve ? { how: 'serve', search, by } : { how: 'pass', why: PASS_WHY.cli, by }
  }
  return undefined
}

/** 路径统一成相对、正斜杠、不带 ./ 和末尾斜杠；「.」表示整个目录，记成空 */
export const normPath = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '')

const IDENT = /^[A-Za-z_]\w*(?:(?:::|[.:])[A-Za-z_]\w*)*$/
const hasExt = (p: string) => /\.[A-Za-z0-9]+$/.test(p.split('/').pop() ?? '')

/**
 * 交给 find 的请求：像名字的（标识符、A.B、A::B）查引用（外部服务给声明和静态引用，文本补动态的），其余按原文找。
 * paths 已换成相对工作目录的（服务端换），文件路径取它所在的目录做范围，扩展名从 -t / *.ext 来
 */
export function findRequestOfSearch(s: SearchSpec, paths: string[]): FindRequest {
  const under = [...new Set(paths.map((p) => (hasExt(p) ? p.split('/').slice(0, -1).join('/') : p)))].filter(Boolean)
  const ext = [...new Set([...s.exts, ...s.include.flatMap((g) => /^\*\.([A-Za-z0-9]+)$/.exec(g)?.[1] ?? [])])].map(
    (e) => e.toLowerCase(),
  )
  const base = {
    kind: IDENT.test(s.pattern) ? ('refs' as const) : ('text' as const),
    query: s.pattern,
    ...(under.length && !paths.includes('') ? { under } : {}),
    ...(ext.length ? { ext } : {}),
  }
  return { ...base, lang: inferLang(base), limit: 200, offset: 0 }
}

/** 文件名通配 → 正则：** 跨目录，* ? 不跨，{a,b} 任选 */
export function globRe(g: string): RegExp {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      re += '.*'
      i++
      if (g[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') re += '(?:'
    else if (c === '}') re += ')'
    else if (c === ',') re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

const globHit = (g: string, file: string) => globRe(g).test(g.includes('/') ? file : (file.split('/').pop() ?? ''))

/** 命中在不在原命令问的范围里：目录、文件、通配、扩展名都对得上 */
export function inScope(file: string, s: SearchSpec, paths: string[]): boolean {
  const f = normPath(file)
  if (paths.length && !paths.some((p) => !p || f === p || f.startsWith(`${p}/`))) return false
  if (s.include.length && !s.include.some((g) => globHit(g, f))) return false
  if (s.exclude.some((g) => globHit(g, f))) return false
  const ext = f.split('.').pop()?.toLowerCase() ?? ''
  return !s.exts.length || s.exts.includes(ext)
}

/** 原命令按原文搜得到这一行吗（那一行里有关键词）：搜得到的不用面板再补 */
export function covered(h: FindHit, s: SearchSpec): boolean {
  const text = h.text ?? ''
  return s.ignoreCase ? text.toLowerCase().includes(s.pattern.toLowerCase()) : text.includes(s.pattern)
}

/** 面板能补的：范围里的声明（排最前，原命令里也有但分不出哪行是声明），和原命令按原文搜不到的 */
export function panelExtras(hits: FindHit[], s: SearchSpec, paths: string[]) {
  const mine = hits.filter((h) => inScope(h.file, s, paths))
  return {
    decls: mine.filter((h) => h.rank === 0).slice(0, DECLS_MAX),
    extras: mine.filter((h) => !covered(h, s)),
  }
}

const DECLS_MAX = 8
/** 面板补的那段最多多少字（ADR 0067 返回预算 4000，给原命令的输出留地方） */
export const SECTION_MAX = 3000
/** 代答时原命令的输出最多放多少字：再长就不代答，交给 CLI 自己截（它截的和面板截的不一样，会少） */
export const ORIGINAL_MAX = 30_000

/** 面板补的那段；没有可补的返回空串 */
export function panelSection(o: { decls: FindHit[]; extras: FindHit[]; served: string }): string {
  if (!o.decls.length && !o.extras.length) return ''
  const out = [`[面板 find · ${o.served || '面板'}]`]
  let used = out[0].length
  const push = (l: string) => {
    if (used + l.length + 1 > SECTION_MAX) return false
    out.push(l)
    used += l.length + 1
    return true
  }
  if (o.decls.length) {
    push('声明：')
    for (const h of o.decls) if (!push(hitLine(h))) break
  }
  if (o.extras.length) {
    push(`原命令按原文搜不到、面板另外找到 ${o.extras.length} 处：`)
    let n = 0
    for (const h of o.extras) {
      if (!push(hitLine(h))) break
      n++
    }
    if (n < o.extras.length) out.push(`（还有 ${o.extras.length - n} 处没列，用面板的 find 工具分页看）`)
  }
  return out.join('\n')
}

/**
 * 改写后的命令：先打印面板那段，再原样跑原命令。原命令放最后，退出码就是原命令的；
 * 「;」在 bash 和 PowerShell 里都是「接着跑下一条」，node 跑的脚本只打印，不依赖外壳。路径一律用正斜杠（Windows 上 node 也认）
 */
export function rewriteCommand(original: string, script: string): string {
  return `node "${script.replace(/\\/g, '/')}"; ${original}`
}

/** 代答的全文：开头只写「结果（面板）」，面板补的在前，原命令的输出原样在后；面板补的里原输出已有的行去掉 */
export function serveText(o: { output: string; decls: FindHit[]; extras: FindHit[]; served: string }): string {
  const seen = (h: FindHit) => (h.line ? o.output.includes(`${h.file}:${h.line}`) : o.output.includes(h.file))
  const section = panelSection({ ...o, extras: o.extras.filter((h) => !seen(h)) })
  const body = o.output.trim() ? o.output.replace(/\s+$/, '') : '（原命令没有找到）'
  return ['结果（面板）', section, body].filter(Boolean).join('\n')
}
