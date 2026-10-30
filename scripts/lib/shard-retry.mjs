/**
 * 端到端、界面检查的分片重跑（scripts/e2e.mjs、scripts/ui-check.mjs 共用）。
 *
 * 和单测一样只重跑失败的部分：一个分片要起服务、开浏览器，整轮重跑要几分钟，而偶发失败通常只有一片。
 * 失败的分片串行再跑一次（并行时抢 CPU、端口正是抖动的来源）；重跑通过记成抖动、照样报出来；
 * 还失败的记进 logs/tests/<种类>-last.json，`--failed` 只跑它们。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RESULTS_DIR } from './test-results.mjs'

/** 一个分片最多跑几次（含第一次）：分片比单测文件贵得多，只多给一次 */
export const SHARD_ATTEMPTS = 2

const lastFile = (root, kind) => path.join(root, RESULTS_DIR, `${kind}-last.json`)

/** 上一次还失败的分片文件名；没有记录时返回 null */
export function lastFailedShards(root, kind) {
  try {
    return JSON.parse(readFileSync(lastFile(root, kind), 'utf8')).failed ?? []
  } catch {
    return null
  }
}

/** 记下这次还失败的、抖动的分片 */
export function saveShardResults(root, kind, failed, flaky) {
  mkdirSync(path.join(root, RESULTS_DIR), { recursive: true })
  writeFileSync(lastFile(root, kind), JSON.stringify({ at: new Date().toISOString(), failed, flaky }, null, 2))
}

/**
 * 失败的分片串行重跑：返回最终结果（重跑的那次替换第一次）和抖动的分片。
 * results 每项要有 file、name、code；run(file) 返回同样形状的结果
 */
export async function retryShards(results, run, { attempts = SHARD_ATTEMPTS, log = console.log } = {}) {
  const final = [...results]
  const flaky = []
  /** 抖动报告用（scripts/lib/flaky-report.mjs）：第几次通过、第一次失败时输出的最后几行 */
  const detail = []
  for (let i = 2; i <= attempts; i++) {
    const failing = final.filter((r) => r.code !== 0)
    if (!failing.length) break
    log(`\n第 ${i} 次：只重跑失败的分片（串行）：${failing.map((r) => r.name).join('、')}`)
    for (const r of failing) {
      const again = await run(r.file)
      final[final.indexOf(r)] = again
      if (again.code === 0) {
        flaky.push(r.name)
        detail.push({ unit: r.name, attempts: i, firstError: (r.out ?? []).slice(-8).join('\n') })
      }
      log(`${again.code === 0 ? '✓ 重跑通过（抖动）' : '✗ 仍失败'}：${r.name}`)
    }
  }
  return { results: final, flaky, detail }
}
