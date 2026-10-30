/**
 * 抖动报告 logs/tests/flaky-report.json：单测、端到端、界面检查三个入口共写一份（openspec test-governance 3.2 / 3.3 / 6.11）。
 *
 * 重跑让偶发失败最后变绿，但抖动本身是要修的问题：只看退出码会把它藏起来。
 * 每个入口跑完用自己这一类（kind）的结果整份替换报告里同类的条目——没有抖动就清空这一类，
 * 所以上一次留下的旧报告不会把这一次干净的运行判红；别的入口写的条目不动。
 * CI 跑完单测后用 scripts/flaky-check-report.mjs 读它，units 非空就判红。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RESULTS_DIR } from './test-results.mjs'

export const FLAKY_REPORT = `${RESULTS_DIR}/flaky-report.json`

/** 首次报错只留这么多字：报告是给人看哪里抖的，完整输出在各自的日志里 */
const ERROR_CHARS = 600

export function readFlakyReport(root) {
  try {
    const r = JSON.parse(readFileSync(path.join(root, FLAKY_REPORT), 'utf8'))
    return { units: Array.isArray(r.units) ? r.units : [], rate: r.rate ?? {} }
  } catch {
    return { units: [], rate: {} }
  }
}

/**
 * 写这一类的结果。entries：抖动的单元 [{ unit, attempts, firstError }]（最后都通过了）；total：这一类这次跑了几个单元
 */
export function writeFlakyReport(root, kind, entries, total) {
  const old = readFlakyReport(root)
  const units = [
    ...old.units.filter((u) => u.kind !== kind),
    ...entries.map((e) => ({
      kind,
      unit: e.unit,
      attempts: e.attempts,
      firstError: String(e.firstError ?? '').slice(0, ERROR_CHARS),
      final: 'passed',
    })),
  ]
  const rate = { ...old.rate, [kind]: total ? Number((entries.length / total).toFixed(4)) : 0 }
  mkdirSync(path.join(root, RESULTS_DIR), { recursive: true })
  writeFileSync(path.join(root, FLAKY_REPORT), JSON.stringify({ at: new Date().toISOString(), units, rate }, null, 2))
  return { units, rate }
}

/** 报告的结论：给 flaky-check-report 和测试用。返回 { ok, lines } */
export function judgeFlakyReport(report) {
  if (!report.units.length) return { ok: true, lines: ['抖动报告：没有抖动的单元'] }
  return {
    ok: false,
    lines: [
      `抖动报告：${report.units.length} 个单元第一次失败、重跑才通过，要修掉时序或共享状态的原因：`,
      ...report.units.map(
        (u) =>
          `  [${u.kind}] ${u.unit}（尝试 ${u.attempts} 次）${u.firstError ? `\n    首次报错：${u.firstError.split('\n')[0]}` : ''}`,
      ),
    ],
  }
}
