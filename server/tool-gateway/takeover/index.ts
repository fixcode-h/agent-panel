/**
 * 查找接管（ADR 0084 第二期，改道模式才跑）：搜索命令、CLI 自带的按内容搜交给 find 能力路由，
 * 结果和原命令的结果并在一起交回。怎么认、补什么、拼成什么样在 shared/tool-gateway/takeover.ts，这里只做有副作用的几步：
 * 查（findCode，带时限）、改写时写打印脚本、代答时照原样跑原命令、把实际走的路挂到工具卡片上。
 *
 * 任何一步出错、超时、拿不准都返回 pass（带原因），网关就把原来那份回答原样交回，CLI 照原命令跑
 */
import path from 'node:path'
import type { HookAnswer } from '../../../shared/hooks/index.ts'
import type { FindCodeRun } from '../../../shared/host/find-code.ts'
import type { NoteToolRoute } from '../../../shared/host/tool-route.ts'
import type { ToolRoute } from '../../../shared/capability-router/tool-route.ts'
import type { SearchSpec } from '../../../shared/tool-gateway/search-args.ts'
import type { CliTakeover } from '../../../shared/tool-gateway/takeover-spec.ts'
import type { FindHit, FindRequest } from '../../../shared/capability-router/find/types.ts'
import {
  findRequestsOfSearch,
  normPath,
  panelExtras,
  panelSection,
  PASS_WHY,
  planTakeover,
  rewriteCommand,
  serveText,
  type TakeoverPlan,
} from '../../../shared/tool-gateway/takeover.ts'
import { rewriteAt } from '../../../shared/tool-gateway/takeover-segments.ts'
import type { CallRecord, ToolCall } from '../../../shared/tool-gateway/types.ts'
import { log } from '../../log.ts'
import { runOriginal } from './original.ts'
import { writePrintScript } from './script.ts'

/** 查找最多等多久：钩子在每次调用的路上，等不到就照原命令跑（能力路由自己能等一分钟，这里不能） */
const ROUTE_MS = 4000
/** 代答时照原样跑原命令最多等多久 */
const ORIGINAL_MS = 15_000

export interface TakeoverDeps {
  takeover: CliTakeover
  /** CLI 定义的钩子里有没有改写模板（hooks.events['tool.before'].rewrite） */
  rewriteTpl: boolean
  /** CLI 的工作目录：命令里的相对路径按它算，代答时原命令在这里跑 */
  cwd: string
  findCode?: FindCodeRun
  noteRoute?: NoteToolRoute
  /** 测试替换：照原样跑原命令、写打印脚本 */
  runOriginal?: (run: NonNullable<SearchSpec['run']>, cwd: string, timeoutMs: number) => Promise<string | undefined>
  writeScript?: (text: string) => Promise<string>
}

/** 接管的结果：answer 是交回 CLI 的回答；pass 时没有，网关用原来那份 */
export interface TakeoverOut {
  decision: 'rewrite' | 'serve' | 'pass'
  why?: string
  answer?: HookAnswer
  /** 改写后的输入：工具后按它配对 */
  input?: Record<string, unknown>
  route?: ToolRoute
}

/** 命令里的路径换成相对工作目录的；工作目录外的（绝对路径、..）返回 undefined：范围对不上 find 的索引 */
function relPaths(paths: string[], cwd: string): string[] | undefined {
  const out: string[] = []
  for (const p of paths) {
    const abs = path.resolve(cwd, p)
    const r = path.relative(cwd, abs)
    if (r.startsWith('..') || path.isAbsolute(r)) return undefined
    out.push(normPath(r))
  }
  return out
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref?.())])

type FindOut = Awaited<ReturnType<FindCodeRun>>

/** 几次查找的结果合成一条：命中按文件和行去重，走过的步骤都列上，给出结果的路去重，耗时取最长（是并发跑的） */
function mergeOuts(outs: FindOut[]): FindOut {
  if (outs.length === 1) return outs[0]
  const hits: FindHit[] = []
  const seen = new Set<string>()
  for (const h of outs.flatMap((o) => o.hits ?? [])) {
    const k = `${h.file}:${h.line ?? ''}`
    if (seen.has(k)) continue
    seen.add(k)
    hits.push(h)
  }
  const routes = outs.map((o) => o.route!)
  const served = routes.flatMap((r) => r.served).filter((x, i, a) => a.findIndex((y) => y.source === x.source) === i)
  const ms = Math.max(...routes.map((r) => r.ms ?? 0))
  return {
    text: outs.map((o) => o.text).join('\n'),
    hits,
    route: { ...routes[0], served, steps: routes.flatMap((r) => r.steps), ms },
  }
}

/**
 * 「或」拆成的几个原文分开查、一起等，命中合起来。
 * 任一个出错或没带路由就整条按出错算：只补一半会让面板那段看着像全部
 */
async function findAll(run: FindCodeRun, reqs: FindRequest[], signal: AbortSignal): Promise<FindOut | undefined> {
  const outs = await withTimeout(Promise.all(reqs.map((q) => run(q, signal))), ROUTE_MS)
  if (!outs) return undefined
  return outs.find((o) => o.error || !o.route) ?? mergeOuts(outs)
}

/** 一个搜索段查一次：查到了给命中和面板能补的，没查成给放行的原因 */
type Looked = { out: FindOut; decls: FindHit[]; extras: FindHit[] } | { why: string }

async function lookup(d: TakeoverDeps, run: FindCodeRun, s: SearchSpec): Promise<Looked> {
  const paths = relPaths(s.paths, d.cwd)
  if (!paths) return { why: '搜的目录不在对话的工作目录里，照原命令跑' }
  const ctl = new AbortController()
  const r = await findAll(run, findRequestsOfSearch(s, paths), ctl.signal)
  if (!r) ctl.abort()
  if (!r || r.error || !r.route) return { why: r?.text ?? `查找 ${ROUTE_MS / 1000} 秒没回来，照原命令跑` }
  return { out: r, ...panelExtras(r.hits ?? [], s, paths) }
}

const servedOf = (route: ToolRoute) => route.served.map((x) => x.label).join(' + ')

/**
 * 改写：每个搜索段各查各的（一起查，查找批量并发），有可补的段在它前面原地插一句打印；
 * 一段都没有可补的就放行。单段命令插在开头（rewriteCommand，和以前一样）
 */
async function rewrite(
  d: TakeoverDeps,
  run: FindCodeRun,
  plan: Extract<TakeoverPlan, { how: 'rewrite' }>,
  call: ToolCall,
  inner: HookAnswer,
): Promise<TakeoverOut> {
  const original = String(call.input.command ?? '')
  const looked = await Promise.all(plan.units.map((u) => lookup(d, run, u.search)))
  const ok = looked.flatMap((l, i) => ('out' in l ? [{ ...l, at: plan.units[i].at }] : []))
  if (!ok.length) return { decision: 'pass', why: (looked[0] as { why: string }).why }
  const route: ToolRoute = { ...mergeOuts(ok.map((x) => x.out)).route!, from: original }
  const sections = ok
    .map((x) => ({
      at: x.at,
      text: panelSection({ decls: x.decls, extras: x.extras, served: servedOf(x.out.route!) }),
    }))
    .filter((x) => x.text)
  if (!sections.length) return { decision: 'pass', why: PASS_WHY.nothing, route }
  const write = d.writeScript ?? writePrintScript
  const inserts = await Promise.all(sections.map(async (x) => ({ at: x.at, script: await write(x.text) })))
  const command =
    plan.units.length === 1 && inserts[0].at === 0
      ? rewriteCommand(original, inserts[0].script)
      : rewriteAt(original, inserts)
  const input = { ...call.input, command }
  d.noteRoute?.(route, original)
  return { decision: 'rewrite', answer: { ...inner, rewrite: input }, input, route }
}

export async function takeover(d: TakeoverDeps, call: ToolCall, inner: HookAnswer): Promise<TakeoverOut | undefined> {
  const plan = planTakeover(call, { takeover: d.takeover, rewriteTpl: d.rewriteTpl })
  if (!plan) return undefined
  if (plan.how === 'pass') return { decision: 'pass', why: plan.why }
  if (!d.findCode) return { decision: 'pass', why: PASS_WHY.noFind }
  if (plan.how === 'rewrite') return rewrite(d, d.findCode, plan, call, inner)

  const s = plan.search
  const l = await lookup(d, d.findCode, s)
  if (!('out' in l)) return { decision: 'pass', why: l.why }
  const original = String(call.input.command ?? '')
  const route: ToolRoute = { ...l.out.route!, from: call.kind === 'shell' ? original : `${call.tool} ${s.pattern}` }
  const { decls, extras } = l
  const served = servedOf(route)

  const output = await (d.runOriginal ?? runOriginal)(s.run!, d.cwd, ORIGINAL_MS)
  if (output === undefined) return { decision: 'pass', why: PASS_WHY.original, route }
  const text = serveText({ output, decls, extras, served })
  // 守卫、推送补的说明照样交给模型：代答时它们跟在结果后面
  const reason = [text, inner.context].filter(Boolean).join('\n\n')
  // 工具卡片上按输入认是哪一行：命令按原文，自带搜索按关键词（输入是 JSON，带引号比）
  d.noteRoute?.(route, call.kind === 'shell' ? original : JSON.stringify(s.pattern))
  return { decision: 'serve', answer: { deny: true, reason }, route }
}

const INPUT_MAX = 2000

/**
 * 网关调这一个：接管不出错地跑完，返回交回 CLI 的回答和要并进调用记录的几项。
 * 网关出错放行（用户 2026-11-26 定）：接管里抛出的任何错都按放行处理，记进 error 和 takeoverWhy
 */
export async function enforceTakeover(
  d: TakeoverDeps,
  call: ToolCall,
  inner: HookAnswer,
): Promise<{
  answer: HookAnswer
  input?: Record<string, unknown>
  patch: Partial<Pick<CallRecord, 'decision' | 'rewritten' | 'route' | 'takeoverWhy' | 'error'>>
}> {
  try {
    const tk = await takeover(d, call, inner)
    if (!tk) return { answer: inner, patch: {} }
    const base = { ...(tk.route ? { route: tk.route } : {}), ...(tk.why ? { takeoverWhy: tk.why } : {}) }
    if (tk.decision === 'pass' || !tk.answer) return { answer: inner, patch: base }
    return {
      answer: tk.answer,
      input: tk.input,
      patch: {
        ...base,
        decision: tk.decision,
        ...(tk.input ? { rewritten: JSON.stringify(tk.input).slice(0, INPUT_MAX) } : {}),
      },
    }
  } catch (e) {
    const msg = (e as Error).message
    log.warn('gateway', '查找接管出错，已放行', { tool: call.tool, error: msg })
    return { answer: inner, patch: { error: msg, takeoverWhy: '网关出错，照原命令跑' } }
  }
}
