/**
 * 诊断报告里的调用栈树（设计稿 2026-11-13「诊断报告：关键调用栈」第 5 节）：档案的 stack 加上面板算的附加信息
 * （日志点挂在哪一跳、打没打、断在哪、选定方案改哪几跳、对上了几帧报错堆栈）拼成 `calltree` 代码块，
 * 界面按 web/src/lib/markdown/call-tree.ts 画成树
 */
import type { BugHop, Diagnosis } from './diagnosis-schema.ts'
import { hopsToCallTree, type HopExtra } from './call-tree.ts'
import { logHits } from './quotes.ts'
import { pastedLog } from './log-watch.ts'
import { phaseOf } from './phase.ts'
import { t } from '../i18n.ts'

/** 日志点按 file:line 对到最近的一跳时，最多差这么多行（再远就不算这一跳上的） */
const ATTACH_NEAR = 30

const normFile = (f: string) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '')

/** 每一跳挂的日志点和假设：写了 hop 的按 hop，没写的日志点按同一文件里最近的一跳 */
function attachOf(d: Pick<Diagnosis, 'stack' | 'logPlan' | 'hypotheses'>, plan: Diagnosis['logPlan']) {
  const out = new Map<string, string[]>()
  const add = (hop: string, id: string) => out.set(hop, [...(out.get(hop) ?? []), id])
  for (const l of plan) {
    if (!l.id.trim()) continue
    if (l.hop.trim()) {
      add(l.hop.trim(), l.id.trim())
      continue
    }
    const near = d.stack
      .filter((h) => h.id && h.line && l.line && normFile(h.file) === normFile(l.file))
      .map((h) => ({ h, gap: Math.abs(h.line! - l.line!) }))
      .filter((x) => x.gap <= ATTACH_NEAR)
      .sort((a, b) => a.gap - b.gap)[0]
    if (near) add(near.h.id, l.id.trim())
  }
  for (const h of d.hypotheses) if (h.hop.trim() && h.id.trim()) add(h.hop.trim(), h.id.trim())
  return out
}

/** 用户贴回的日志：论证这一版自己的；根因、方案沿用最近一轮贴了日志的论证 */
function logSource(d: Diagnosis, list: Diagnosis[]): Pick<Diagnosis, 'logs' | 'logPlan'> | undefined {
  if (pastedLog(d.logs) && d.logPlan.length) return d
  if (phaseOf(d) === 'evidence') return undefined
  const upto = list.indexOf(d) >= 0 ? list.slice(0, list.indexOf(d)) : list
  return [...upto].reverse().find((x) => phaseOf(x) === 'evidence' && !!pastedLog(x.logs) && x.logPlan.length > 0)
}

/** 深度优先的顺序（和画出来的顺序一样） */
function dfs(hops: BugHop[]): BugHop[] {
  const byId = new Map(hops.map((h) => [h.id, h]))
  const legacy = hops.every((h) => !h.id && !h.parent)
  if (legacy) return hops
  const kids = new Map<string, BugHop[]>()
  const roots: BugHop[] = []
  for (const h of hops)
    if (h.parent && byId.has(h.parent)) kids.set(h.parent, [...(kids.get(h.parent) ?? []), h])
    else roots.push(h)
  const out: BugHop[] = []
  const walk = (h: BugHop) => {
    if (out.includes(h)) return
    out.push(h)
    for (const k of kids.get(h.id) ?? []) walk(k)
  }
  roots.forEach(walk)
  return out
}

/**
 * 「断在这里」：按执行顺序，最后一个打出来的日志点之后，第一个该打没打的那一跳前面画一条线。
 * 全打出来了、全没打出来都不画（看不出断在哪）
 */
function cutOf(hops: BugHop[], attach: Map<string, string[]>, hits: Map<string, boolean>): HopExtra['cut'] {
  const order = dfs(hops)
  const state = (h: BugHop) => {
    const ls = (attach.get(h.id) ?? []).filter((r) => hits.has(r))
    return { hit: ls.find((r) => hits.get(r)), miss: ls.find((r) => hits.get(r) === false) }
  }
  let lastHit = ''
  for (const h of order) {
    const s = state(h)
    if (s.miss && lastHit) return { before: h.id, text: t('断在这里：{a} 之后没有 {b}', { a: lastHit, b: s.miss }) }
    if (s.hit) lastHit = s.hit
  }
  return undefined
}

/**
 * 候选方案画在树上（设计稿第 7.1 条）：每个方案改在哪几跳。写了 hops 的按 hops；没写时出错点在方案的文件里
 * 就算改在出错点。一眼看出「方案 A 改在出错点、方案 B 改在调用方」
 */
function fixHops(d: Diagnosis): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const fault = d.stack.find((h) => h.role === 'fault')
  for (const o of d.options) {
    if (!o.id.trim()) continue
    const files = new Set(o.files.map(normFile))
    const hops = o.hops.length ? o.hops : fault?.id && files.has(normFile(fault.file)) ? [fault.id] : []
    for (const h of hops) out.set(h, [...(out.get(h) ?? []), o.id.trim()])
  }
  return out
}

/** 树上方的说明：调用栈从哪来、位置核对了几跳、对上几帧报错堆栈 */
function captionOf(d: Diagnosis): string[] {
  const placed = d.stack.filter((h) => h.check)
  const okN = placed.filter((h) => h.check!.ok).length
  const from = d.stackFrom
  const frames = d.stack.filter((h) => h.check?.frame).length
  return [
    from?.kind === 'trace'
      ? t('来自报错堆栈 {q} · {n} 跳对上了堆栈里的帧', { q: from.trace, n: frames })
      : from?.kind === 'debugger'
        ? t('调试器里看到的调用栈')
        : t('读代码推出'),
    placed.length ? t('位置已核对 {ok}/{n}', { ok: okN, n: placed.length }) : '',
  ].filter(Boolean)
}

/** 档案的调用栈 → `calltree` 代码块（带围栏）；没有调用栈返回空串 */
export function callTreeMd(d: Diagnosis, list: Diagnosis[] = []): string {
  if (!d.stack.length) return ''
  const logs = logSource(d, list)
  const plan = logs?.logPlan ?? d.logPlan
  const attach = attachOf(d, plan)
  const hits = logs
    ? new Map(logHits(pastedLog(logs.logs), logs.logPlan).map((h) => [h.point.id, h.count > 0]))
    : undefined
  const phase = phaseOf(d)
  const text = hopsToCallTree(d.stack, {
    attach,
    hits,
    cut: hits ? cutOf(d.stack, attach, hits) : undefined,
    fix: phase === 'plan' ? fixHops(d) : undefined,
    chosen: d.chosen?.id.trim() || (d.options.length === 1 ? d.options[0].id : undefined),
    caption: captionOf(d),
  })
  const fence = text.includes('```') ? '~~~~' : '```'
  return `${fence}calltree\n${text}\n${fence}`
}

/** 决策卡上的胶囊：位置核对过的跳数（有对不上的另算） */
export function stackTag(d: Diagnosis): { text: string; warn: boolean } | undefined {
  const placed = d.stack.filter((h) => h.check)
  if (!placed.length) return undefined
  const ok = placed.filter((h) => h.check!.ok).length
  return ok === placed.length
    ? { text: t('调用栈已核对 {n}/{n}', { n: placed.length }), warn: false }
    : { text: t('调用栈 {ok}/{n} 对上', { ok, n: placed.length }), warn: true }
}
