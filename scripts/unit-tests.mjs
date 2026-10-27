#!/usr/bin/env node
/**
 * 单测分两批跑：含真实时钟断言的几个文件串行，其余文件按默认并发。
 *
 * 为什么拆：node --test 默认按 CPU 核数并发跑文件，计时类用例（等落盘窗口、等请求超时）
 * 和别的文件抢 CPU 时等待会被拉长，断言随机失败；全量串行又慢到几分钟。
 * 真正吃时间的只有下面清单里的几个文件，其余文件并行不影响彼此。
 *
 * 用法：
 *   node scripts/unit-tests.mjs          # 两批都跑（npm run test:unit）
 *   node scripts/unit-tests.mjs timing   # 只跑计时文件，串行
 *   node scripts/unit-tests.mjs rest     # 只跑其余文件，默认并发
 *   node scripts/unit-tests.mjs --files a.test.ts,b.test.ts   # 只跑指定文件（test:affected 用）
 *   node scripts/unit-tests.mjs --failed  # 只跑上一次还失败的文件（改完复测用，npm run test:failed）
 *   node scripts/unit-tests.mjs --verbose # 完整 TAP 也打到终端（默认只写进 logs/tests/）
 *   node scripts/unit-tests.mjs --no-retry # 失败不重跑（排查抖动时看第一次的真实结果）
 *
 * 输出默认只有每批的结论、失败详情、抖动和最慢的文件：完整 TAP 一次全量有五十万字节，
 * Agent 把它读进上下文就是十几万 token。失败只重跑失败的文件（串行、总共最多 3 次），
 * 不整套重跑；规则和判定在 scripts/lib/test-results.mjs。
 *
 * --files 的文件清单由 scripts/changed-tests.mjs 按影响面分析算出来；这里仍然按
 * timing / rest 两批跑，所以按影响面临时选出来的计时文件也不会和别人抢 CPU。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanTestEnv } from './lib/test-env.mjs'
import { listUnitTests } from './lib/test-files.mjs'
import {
  LAST_RESULTS,
  MAX_ATTEMPTS,
  RESULTS_DIR,
  classifyAttempts,
  failedFiles,
  failureText,
  parseEvents,
  slowest,
  summarize,
} from './lib/test-results.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 有真实时钟断言、必须独占 CPU 的文件：新出现这类用例时加到这里，不要另起一份清单 */
const TIMING_FILES = [
  'server/exec/worktree.test.ts',
  'server/exec/pi-rpc.test.ts',
  'server/task-store.test.ts',
  'server/exec/process.test.ts',
  // 后台命令名额的用例靠 1 秒内的 setTimeout 轮询等排队/启动，和别的文件抢事件循环时会晚于窗口
  'server/background.test.ts',
]

const TSX_CLI = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/**
 * 取出 --files（`--files a.test.ts,b.test.ts` 或 `--files=a,b`）：受影响的单测文件由
 * scripts/changed-tests.mjs 算出来，这里只负责按 timing / rest 两批跑它们。
 */
function splitFilesArg(list) {
  const files = []
  const rest = []
  for (let i = 0; i < list.length; i++) {
    const arg = list[i]
    if (arg === '--files') {
      files.push(...String(list[++i] ?? '').split(','))
      continue
    }
    if (arg.startsWith('--files=')) {
      files.push(...arg.slice('--files='.length).split(','))
      continue
    }
    rest.push(arg)
  }
  return { files: files.map((s) => s.trim()).filter(Boolean), rest }
}

/** 本入口自己的开关，不透传给 node --test */
const OWN_FLAGS = ['--failed', '--verbose', '--no-retry']
const raw = process.argv.slice(2)
const flag = (f) => raw.includes(f)
const { files: picked, rest: argvAfterFiles } = splitFilesArg(raw.filter((a) => !OWN_FLAGS.includes(a)))
const argv = argvAfterFiles
const verbose = flag('--verbose')
const retry = !flag('--no-retry')
/** --failed：上一次还失败的文件；上一次全过或没有记录时直接说明，不退回全量 */
const lastFailed = () => {
  try {
    return JSON.parse(readFileSync(path.join(root, LAST_RESULTS), 'utf8')).failed ?? []
  } catch {
    return null
  }
}
const given = flag('--failed') ? (lastFailed() ?? []) : picked
if (flag('--failed') && !given.length) {
  console.log(
    lastFailed()
      ? '[unit] 上一次没有失败的文件，不用重跑'
      : `[unit] 没有上一次的结果（${LAST_RESULTS}），先跑一次全量或 --files`,
  )
  process.exit(0)
}
const which = ['timing', 'rest'].includes(argv[0]) ? argv[0] : ''
// 第一个位置参数只能是 timing / rest；其余参数原样透传给 node --test，
// 保持原来的用法（`npm run test:unit -- --test-name-pattern 桥接` 也不受影响）。
// 选项的值（例如「桥接」）在 argv[0] 是选项时不会被当成位置参数
if (!which && argv[0] && !argv[0].startsWith('-')) {
  console.error(`不认识的参数 ${argv[0]}：只支持 timing / rest，其余选项会透传给 node --test`)
  process.exit(1)
}
const extra = which ? argv.slice(1) : argv
if (given.length && which) {
  console.error('--files 和 timing / rest 不能同时用：指定了文件就只跑这些文件')
  process.exit(1)
}
if (!existsSync(TSX_CLI)) {
  // 启动校验失败直接退出：这里没有后续内容要跑，exit() 的截断风险只影响长输出
  console.error(`找不到 tsx（${TSX_CLI}）：这个目录还没装依赖，先跑 npm ci`)
  process.exit(1)
}

const all = listUnitTests(root)
// 计时文件改名后清单会和实际文件对不上：静默少跑这几个等于把并发抖动放回来，直接失败
const missing = TIMING_FILES.filter((file) => !all.includes(file))
if (missing.length) {
  console.error(`TIMING_FILES 里的路径不存在（改名后要同步这份清单）：${missing.join('、')}`)
  process.exit(1)
}
const rest = all.filter((file) => !TIMING_FILES.includes(file))

const REPORTER = path.join(root, 'scripts/lib/test-reporter.mjs')
mkdirSync(path.join(root, RESULTS_DIR), { recursive: true })

/**
 * 跑一批文件：tsx + node --test，两个 reporter——自定义的出结构化事件（汇总用），tap 写进日志文件。
 * --verbose 时 tap 也打到终端。返回事件、耗时、退出码和日志路径
 */
function run(files, extra, logName) {
  const log = path.join(RESULTS_DIR, `${logName}.tap`)
  const reporters = [
    `--test-reporter=${REPORTER}`,
    '--test-reporter-destination=stdout',
    '--test-reporter=tap',
    `--test-reporter-destination=${log}`,
    ...(verbose ? ['--test-reporter=tap', '--test-reporter-destination=stderr'] : []),
  ]
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [TSX_CLI, '--test', ...reporters, ...extra, ...files], {
    cwd: root,
    // 继承来的接口变量（ANTHROPIC_BASE_URL 这类）会让断言随机器变：去掉（scripts/lib/test-env.mjs）
    env: cleanTestEnv().env,
    stdio: ['ignore', 'pipe', verbose ? 'inherit' : 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) throw result.error
  const events = parseEvents(result.stdout?.toString() ?? '')
  return { ms: Date.now() - startedAt, code: result.status ?? 1, events, log, stderr: result.stderr?.toString() ?? '' }
}

const sec = (ms) => `${(ms / 1000).toFixed(1)}s`

const batches = []
if (given.length) {
  // 指定的文件必须都是这套规则认识的文件：拼错或改了名时宁可直接失败，也不能静默少跑
  const unknown = given.filter((file) => !all.includes(file))
  if (unknown.length) {
    console.error(`--files 里有不认识的测试文件：${unknown.join('、')}`)
    process.exit(1)
  }
  const timing = all.filter((file) => given.includes(file) && TIMING_FILES.includes(file))
  const others = all.filter((file) => given.includes(file) && !TIMING_FILES.includes(file))
  batches.push(['指定的计时文件（串行）', timing, [...extra, '--test-concurrency=1']])
  batches.push(['指定的其余文件（默认并发）', others, extra])
} else {
  // 计时文件先跑：整轮有失败时也能先看到最容易抖的那批结果
  if (which !== 'rest') batches.push(['计时文件（串行）', TIMING_FILES, [...extra, '--test-concurrency=1']])
  if (which !== 'timing') batches.push(['其余文件（默认并发）', rest, extra])
}

let exitCode = 0
/** 每批的结论，最后单独打成一行：前面批次的结果会被长输出滚上去 */
const verdicts = []
const allSummary = []
const stillFailed = []
const flakyAll = []
for (const [label, files, opts] of batches) {
  if (!files.length) {
    console.log(`[unit] ${label}：没有文件，跳过`)
    continue
  }
  const slug = label.startsWith('计时') || label.startsWith('指定的计时') ? 'timing' : 'rest'
  const first = run(files, opts, `unit-${slug}`)
  const summary = summarize(first.events, root)
  allSummary.push(...summary)
  const tests = summary.reduce((n, f) => n + f.tests, 0)
  let failing = failedFiles(summary)
  // 退出码非零却没解析到失败用例：多半是进程级的错误（加载失败、超时被杀），不能当成通过
  if (first.code && !failing.length) {
    console.log(`\n[unit] ${label}：退出码 ${first.code}，但没有解析到失败的用例。stderr 末尾：`)
    console.log(first.stderr.split('\n').slice(-30).join('\n'))
    console.log(`完整输出：${first.log}`)
    failing = files
  }
  console.log(
    `\n[unit] ${label}：${files.length} 个文件 · ${tests} 条用例 · ${sec(first.ms)} · ${failing.length ? `${failing.length} 个文件失败` : '通过'}`,
  )
  for (const f of summary) for (const x of f.failures) console.log(failureText(f.file, x))
  // 只重跑失败的文件，串行（抖动多半来自和别的文件抢 CPU）；每次只带上一次还失败的
  const attempts = [failing]
  for (let i = 2; retry && failing.length && i <= MAX_ATTEMPTS; i++) {
    const again = run(failing, [...extra, '--test-concurrency=1'], `unit-${slug}-retry${i}`)
    const now = failedFiles(summarize(again.events, root))
    failing = again.code && !now.length ? failing : now
    attempts.push(failing)
    console.log(
      `[unit] 第 ${i} 次（只重跑失败的文件，串行）：${failing.length ? `还有 ${failing.length} 个失败：${failing.join('、')}` : '全部通过'}`,
    )
  }
  const { failed, flaky } = classifyAttempts(attempts)
  stillFailed.push(...failed)
  flakyAll.push(...flaky)
  const verdict = failed.length ? '失败' : flaky.length ? '通过（有抖动）' : '通过'
  console.log(`[unit] 完整输出：${first.log}`)
  verdicts.push(`${label}${verdict}`)
  if (failed.length) exitCode = 1
}

if (flakyAll.length)
  console.log(
    `\n[unit] ⚠ 抖动（第一次失败、重跑通过）：${flakyAll.join('、')}\n  这些文件的断言依赖时序或共享状态，要改成不靠真实等待的写法，不要靠重跑兜着。`,
  )
const slow = allSummary.flatMap((f) => f.slow.map((x) => ({ ...x, file: f.file })))
if (slow.length)
  console.log(
    `\n[unit] 慢用例（单条超过 2s）：\n${slow
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8)
      .map((x) => `  ${sec(x.ms)}  ${x.file} › ${x.name}`)
      .join('\n')}`,
  )
if (!given.length)
  console.log(
    `\n[unit] 最慢的文件：\n${slowest(allSummary)
      .map((f) => `  ${sec(f.ms)}  ${f.file}（${f.tests} 条）`)
      .join('\n')}`,
  )
// 记下这次还失败的文件：--failed 只跑它们
writeFileSync(
  path.join(root, LAST_RESULTS),
  JSON.stringify(
    { at: new Date().toISOString(), failed: [...new Set(stillFailed)], flaky: [...new Set(flakyAll)] },
    null,
    2,
  ),
)
if (stillFailed.length) console.log(`\n[unit] 改完后只复测这些文件：npm run test:failed`)
// 汇总行和判定逻辑无关，只是防止「前一批失败、最后一批通过」被读成「全过却退出码非零」
console.log(`[unit] 汇总：${verdicts.length ? verdicts.join('；') : '没有批次'} → 退出码 ${exitCode}`)
// 用 exitCode 而不是 exit()：stdout 不是终端（CI 管道）时 exit() 会丢掉最后一行汇总
process.exitCode = exitCode
