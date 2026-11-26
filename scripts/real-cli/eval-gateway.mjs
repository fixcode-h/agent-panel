/**
 * 真实评测里看工具网关（ADR 0084）：读数据目录 logs/tool-calls/*.jsonl，按项目算这一题的调用数、各决定数、
 * 能改道的次数、网关自身和整个钩子的耗时分位、面板自己跑了几次校验。只看面板记下的调用，不看模型回复文字。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const q = (xs, p) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100 : 0
}

/** 一个项目的网关统计；没有记录时返回 undefined */
export function gatewayStats(dataDir, projectId) {
  const dir = path.join(dataDir, 'logs', 'tool-calls')
  if (!existsSync(dir)) return undefined
  const calls = new Map()
  const done = new Map()
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')))
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const r = JSON.parse(line)
      if (r.t === 'call' && r.projectId === projectId) calls.set(r.id, r)
      else if (r.t === 'done') done.set(r.id, r)
    }
  const all = [...calls.values()]
  if (!all.length) return undefined
  const decisions = {}
  for (const r of all) decisions[r.decision] = (decisions[r.decision] ?? 0) + 1
  const shell = all.filter((r) => r.kind === 'shell')
  return {
    calls: all.length,
    decisions,
    wouldRoute: all.filter((r) => r.wouldRoute).length,
    // Agent 自己在命令行里搜（rg / grep / find）和用面板 find 的次数
    shellSearch: shell.filter((r) => r.category === 'search').length,
    panelFind: all.filter((r) => r.capability === 'find' && r.kind !== 'shell').length,
    gwMs: {
      p50: q(
        all.map((r) => r.ms),
        0.5,
      ),
      p95: q(
        all.map((r) => r.ms),
        0.95,
      ),
    },
    hookMs: {
      p50: q(
        all.map((r) => r.hookMs),
        0.5,
      ),
      p95: q(
        all.map((r) => r.hookMs),
        0.95,
      ),
    },
    execMs: {
      p50: q(
        all.map((r) => done.get(r.id)?.durMs),
        0.5,
      ),
    },
    skills: all.flatMap((r) => r.skills ?? []).reduce((n, s) => n + (s.tokens ?? 0), 0),
    verify: all.filter((r) => r.verify).length,
    errors: all.filter((r) => r.error).length,
  }
}
