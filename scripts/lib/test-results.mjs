/**
 * 单测结果的汇总和重跑判定（纯函数，scripts/unit-tests.mjs 用）。
 *
 * 三条约定，都是为了省掉「失败了就整套重跑」和「整屏 TAP 读进上下文」这两笔开销：
 * - 输出只给失败详情、抖动和最慢的几个文件；完整 TAP 写进日志文件，要看再去看；
 * - 失败只重跑失败的文件，串行，总共最多 MAX_ATTEMPTS 次；重跑通过的记成「抖动」，照样显眼地报出来；
 * - 最后一次的失败文件记在 LAST_RESULTS，`--failed` 只跑它们（改完代码复测不用再跑全量）。
 */
import path from 'node:path'
import { EVENT_PREFIX } from './test-reporter.mjs'

/** 一个文件最多跑几次（含第一次）：第三次还失败就是真失败 */
export const MAX_ATTEMPTS = 3
/** 单个用例超过这个耗时算慢用例：汇总里列出来，提醒改成不靠真实等待的写法 */
export const SLOW_TEST_MS = 2000
/** 汇总里列几个最慢的文件 */
export const SLOWEST_FILES = 5
/** 每条失败详情最多打几行：完整输出在日志里 */
export const FAILURE_LINES = 20
/** 结果和日志放在 logs/tests/（logs/ 已在 .gitignore 里） */
export const RESULTS_DIR = 'logs/tests'
export const LAST_RESULTS = `${RESULTS_DIR}/unit-last.json`

/** 读 reporter 打出来的事件行；不是事件的行（用例自己打的输出）跳过 */
export function parseEvents(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.startsWith(EVENT_PREFIX)) continue
    try {
      out.push(JSON.parse(line.slice(EVENT_PREFIX.length)))
    } catch {}
  }
  return out
}

/** 绝对路径换成相对仓库根、用 / 分隔 */
export const relFile = (root, file) => (file ? path.relative(root, file).split(path.sep).join('/') : '')

/**
 * 按文件汇总：每个文件的用例数、失败数、耗时（顶层用例耗时之和）、失败用例、慢用例。
 * 文件整个加载失败时 node 用文件路径当用例名报一条失败，file 可能为空，按名字归到那个文件
 */
export function summarize(events, root) {
  const files = new Map()
  const of = (file) => {
    if (!files.has(file)) files.set(file, { file, tests: 0, failed: 0, ms: 0, failures: [], slow: [] })
    return files.get(file)
  }
  for (const e of events) {
    const file = relFile(root, e.file) || relFile(root, e.name)
    const f = of(file)
    if (e.nesting === 0) f.ms += e.ms
    if (!e.suite) f.tests++
    // 外层 describe / 带子用例的 test 失败只是「里面有子用例失败」：详情在子用例那条，这里不重复列
    if (!e.ok && !e.skip && !e.wrapper && !e.suite) {
      f.failed++
      f.failures.push({ name: e.name, error: e.error ?? '' })
    }
    if (e.ok && e.ms > SLOW_TEST_MS) f.slow.push({ name: e.name, ms: e.ms })
  }
  return [...files.values()]
}

/** 汇总里列失败的文件：有失败用例的 */
export const failedFiles = (summary) => summary.filter((f) => f.failed > 0).map((f) => f.file)

/**
 * 几次尝试的结论：attempts[i] 是第 i 次还失败的文件。
 * 最后一次还失败的是真失败；之前失败、后来通过的是抖动
 */
export function classifyAttempts(attempts) {
  const first = new Set(attempts[0] ?? [])
  const last = new Set(attempts.at(-1) ?? [])
  return {
    failed: [...last],
    flaky: [...first].filter((f) => !last.has(f)),
  }
}

/** 一条失败的详情：截到 FAILURE_LINES 行 */
export function failureText(file, f) {
  const lines = String(f.error || '（没有错误信息，见完整日志）').split('\n')
  const body = lines.slice(0, FAILURE_LINES).map((l) => `    ${l}`)
  if (lines.length > FAILURE_LINES) body.push(`    …（还有 ${lines.length - FAILURE_LINES} 行，见完整日志）`)
  return [`✗ ${file} › ${f.name}`, ...body].join('\n')
}

/** 最慢的几个文件 */
export const slowest = (summary, n = SLOWEST_FILES) =>
  [...summary]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n)
    .filter((f) => f.ms > 0)
