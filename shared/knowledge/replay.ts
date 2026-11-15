import type { ProjectLesson, ToolUse } from '../schema.ts'
import type { ProjectExperience } from '../experience.ts'
import { relPath } from '../experience-gate.ts'
import {
  budgetHits,
  commandLessons,
  errorLessons,
  pathLessons,
  pushText,
  searchExperience,
  type PushHit,
} from './push.ts'
import { searchText } from './match/normalize.ts'
import { errorPrint, printKey } from './match/fingerprint.ts'
import { purposeOf } from './capture.ts'

/**
 * 回放评测（设计稿 6.4，一期 ①）：拿已有对话里的工具调用，按时间顺序重放面板钩子的推送规则，
 * 量出「会推多少、推什么、花多少字」，以及根因（第 3 节）里几件事在真实对话里有多常见：
 * 失败后换了做法才成的次数、同一个报错在之后的对话里复发的次数、搜了多久才动手。
 * 纯函数：scripts/knowledge-replay.mjs 读数据目录后交给这里，单测也直接喂假数据。
 * 注意：用的是现在的教训和经验去配历史对话，不是当时的；量的是「现在这套规则放到那时会怎样」
 */

export interface ReplayConversation {
  id: string
  title: string
  at: string
  tools: ToolUse[]
}

export interface ReplayStats {
  conversations: number
  tools: { run: number; edit: number; read: number; search: number }
  failures: number
  /** 推送次数和条目：按时机分 */
  pushes: Record<PushHit['why'], number>
  pushedItems: Record<PushHit['why'], number>
  /** 推送的总字数、有推送的对话数、每个对话最多推了多少字 */
  pushChars: number
  convWithPush: number
  maxConvChars: number
  /** 每条被推了几次（按对话算） */
  topHits: { id: string; kind: PushHit['kind']; title: string; convs: number }[]
  /** 失败后换了做法才成（教训的苗子，三期当场捕获要认的就是它） */
  fixAfterFail: number
  /** 同一个报错特征在之后的对话里又出现（复发）：已有教训覆盖的 / 没覆盖的 */
  recurCovered: number
  recurUncovered: number
  /** 没覆盖、复发最多的报错（前几个），提炼时优先补 */
  topRecur: { sample: string; convs: number }[]
  /** 第一次改文件之前搜了 / 读了几步：中位数、超过 8 步的对话数 */
  detourMedian: number
  detourOver8: number
  /** 匹配耗时（毫秒，每次工具调用）：p95 */
  matchP95: number
}

const KIND_OF: Record<string, 'shell' | 'edit' | 'read' | undefined> = {
  run: 'shell',
  edit: 'edit',
  read: 'read',
  search: 'read',
}

/** 工具行转成钩子看到的样子（命令、路径、搜索参数）；不是这几类返回 undefined */
export function toolFacts(t: ToolUse, roots: string[]) {
  const kind = KIND_OF[t.kind]
  if (!kind) return undefined
  const raw = (t.input || t.label || '').trim()
  if (t.kind === 'run') return { kind, input: { command: raw } as Record<string, unknown>, path: '' }
  if (t.kind === 'search') {
    // 搜索行的标题是「搜索词 · 目录」（server/exec/parsers.ts 的 searchLabel）
    const [pattern, where = ''] = t.label.split(' · ')
    return { kind, input: { pattern, path: where } as Record<string, unknown>, path: '' }
  }
  return { kind, input: {} as Record<string, unknown>, path: relPath(t.label, roots) }
}

const failedOf = (t: ToolUse) => !!t.failed || (t.exitCode !== undefined && t.exitCode !== 0)
export function replay(
  convs: ReplayConversation[],
  lessons: ProjectLesson[],
  exps: ProjectExperience[],
  roots: string[],
  /** 计时：默认用高精度时钟（浏览器、Node 都有 performance），单测可以换 */
  now: () => number = () => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now(),
): ReplayStats {
  const s: ReplayStats = {
    conversations: convs.length,
    tools: { run: 0, edit: 0, read: 0, search: 0 },
    failures: 0,
    pushes: { command: 0, path: 0, error: 0, search: 0 },
    pushedItems: { command: 0, path: 0, error: 0, search: 0 },
    pushChars: 0,
    convWithPush: 0,
    maxConvChars: 0,
    topHits: [],
    fixAfterFail: 0,
    recurCovered: 0,
    recurUncovered: 0,
    topRecur: [],
    detourMedian: 0,
    detourOver8: 0,
    matchP95: 0,
  }
  const on = lessons.filter((l) => l.enabled)
  const es = exps.filter((e) => e.enabled)
  const hitConvs = new Map<string, { kind: PushHit['kind']; title: string; convs: Set<string> }>()
  const times: number[] = []
  const detours: number[] = []
  /** 报错特征 → 出现在哪些对话、有没有教训覆盖、一段原文 */
  const prints = new Map<string, { convs: Set<string>; covered: boolean; sample: string }>()
  for (const c of [...convs].sort((a, b) => a.at.localeCompare(b.at))) {
    const seen = new Set<string>()
    let chars = 0
    let steps = 0
    let edited = false
    for (let i = 0; i < c.tools.length; i++) {
      const t = c.tools[i]
      if (t.kind in s.tools) s.tools[t.kind as keyof ReplayStats['tools']]++
      const f = toolFacts(t, roots)
      if (!f) continue
      const failed = failedOf(t)
      if (!edited) {
        if (t.kind === 'edit') {
          edited = true
          detours.push(steps)
        } else if (t.kind === 'read' || t.kind === 'search') steps++
      }
      const t0 = now()
      const q = searchText(f.kind, f.input)
      let why: PushHit['why'] | '' = ''
      let all: PushHit[] = []
      if (q !== null) {
        why = 'search'
        all = searchExperience(es, q, String(f.input.path ?? ''))
      } else if (f.kind === 'shell') {
        why = 'command'
        all = commandLessons(on, String(f.input.command))
      } else if (f.kind === 'edit') {
        why = 'path'
        all = pathLessons(on, f.path)
      }
      const before = budgetHits(all.filter((h) => !seen.has(h.id)))
      let after: PushHit[] = []
      if (failed && t.output) after = budgetHits(errorLessons(on, t.output).filter((h) => !seen.has(h.id)))
      times.push(now() - t0)
      for (const [w, hits] of [
        [why, before],
        ['error', after],
      ] as const) {
        if (!w || !hits.length) continue
        s.pushes[w]++
        s.pushedItems[w] += hits.length
        chars += pushText(hits, w, q ?? String(f.input.command ?? f.path)).length
        for (const h of hits) {
          seen.add(h.id)
          const e = hitConvs.get(h.id) ?? { kind: h.kind, title: h.title, convs: new Set<string>() }
          e.convs.add(c.id)
          hitConvs.set(h.id, e)
        }
      }
      if (!failed) continue
      s.failures++
      if (t.output) {
        const key = printKey(errorPrint(t.output))
        if (key) {
          const p = prints.get(key) ?? {
            convs: new Set<string>(),
            covered: false,
            sample: errorPrint(t.output).words.slice(0, 8).join(' '),
          }
          p.convs.add(c.id)
          if (after.length || errorLessons(on, t.output).length) p.covered = true
          prints.set(key, p)
        }
      }
      // 失败后换了做法才成：之后 5 步里同目的的命令成功了、而且命令本身变了（只是重试同一条的不算）
      if (t.kind === 'run') {
        const cmd = (t.input || t.label).trim()
        const purpose = purposeOf(cmd)
        const next = c.tools
          .slice(i + 1, i + 6)
          .find((x) => x.kind === 'run' && purposeOf((x.input || x.label).trim()) === purpose)
        if (purpose && next && !failedOf(next) && (next.input || next.label).trim() !== cmd) s.fixAfterFail++
      }
    }
    if (!edited) detours.push(steps)
    s.pushChars += chars
    if (chars) s.convWithPush++
    s.maxConvChars = Math.max(s.maxConvChars, chars)
  }
  s.topHits = [...hitConvs]
    .map(([id, e]) => ({ id, kind: e.kind, title: e.title, convs: e.convs.size }))
    .sort((a, b) => b.convs - a.convs)
    .slice(0, 10)
  for (const p of prints.values())
    if (p.convs.size > 1) {
      if (p.covered) s.recurCovered++
      else s.recurUncovered++
    }
  s.topRecur = [...prints.values()]
    .filter((p) => !p.covered && p.convs.size > 1)
    .sort((a, b) => b.convs.size - a.convs.size)
    .slice(0, 8)
    .map((p) => ({ sample: p.sample, convs: p.convs.size }))
  const sorted = [...detours].sort((a, b) => a - b)
  s.detourMedian = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  s.detourOver8 = detours.filter((d) => d >= 8).length
  const ts = [...times].sort((a, b) => a - b)
  s.matchP95 = ts.length ? Number(ts[Math.min(ts.length - 1, Math.floor(ts.length * 0.95))].toFixed(3)) : 0
  return s
}
