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
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 测试文件分布在这几棵目录下；每棵目录只收自己那种后缀（旧 glob：scripts 是 `.test.mjs`，其余是 `.test.ts`） */
const TEST_ROOTS = [
  ['server', /\.test\.ts$/],
  ['shared', /\.test\.ts$/],
  ['web/src', /\.test\.ts$/],
  ['scripts', /\.test\.mjs$/],
]

/** 依赖和生成物里没有源码测试，递归时整棵剪掉，免得把装出来的东西当成用例 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-demo',
  'release',
  'ui-shots',
  'attachments',
  'coverage',
  '.git',
])

const TSX_CLI = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/** 按原先 test:unit 的口径枚举用例文件，返回相对 root、用 / 分隔的路径 */
function listTests(dir, suffix) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (suffix.test(entry.name)) {
        out.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(root, dir))
  return out
}

const argv = process.argv.slice(2)
const which = ['timing', 'rest'].includes(argv[0]) ? argv[0] : ''
// 第一个位置参数只能是 timing / rest；其余参数原样透传给 node --test，
// 保持原来的用法（`npm run test:unit -- --test-name-pattern 桥接` 也不受影响）。
// 选项的值（例如「桥接」）在 argv[0] 是选项时不会被当成位置参数
if (!which && argv[0] && !argv[0].startsWith('-')) {
  console.error(`不认识的参数 ${argv[0]}：只支持 timing / rest，其余选项会透传给 node --test`)
  process.exit(1)
}
const extra = which ? argv.slice(1) : argv
if (!existsSync(TSX_CLI)) {
  // 启动校验失败直接退出：这里没有后续内容要跑，exit() 的截断风险只影响长输出
  console.error(`找不到 tsx（${TSX_CLI}）：这个目录还没装依赖，先跑 npm ci`)
  process.exit(1)
}

const all = TEST_ROOTS.flatMap(([dir, suffix]) => listTests(dir, suffix)).sort()
// 计时文件改名后清单会和实际文件对不上：静默少跑这几个等于把并发抖动放回来，直接失败
const missing = TIMING_FILES.filter((file) => !all.includes(file))
if (missing.length) {
  console.error(`TIMING_FILES 里的路径不存在（改名后要同步这份清单）：${missing.join('、')}`)
  process.exit(1)
}
const rest = all.filter((file) => !TIMING_FILES.includes(file))

/** 跑一批文件：沿用 tsx + node --test，输出直接透到终端，返回耗时和退出码 */
function run(files, extra = []) {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [TSX_CLI, '--test', ...extra, ...files], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  return { ms: Date.now() - startedAt, code: result.status ?? 1 }
}

const batches = []
// 计时文件先跑：整轮有失败时也能先看到最容易抖的那批结果
if (which !== 'rest') batches.push(['计时文件（串行）', TIMING_FILES, [...extra, '--test-concurrency=1']])
if (which !== 'timing') batches.push(['其余文件（默认并发）', rest, extra])

let exitCode = 0
for (const [label, files, opts] of batches) {
  if (!files.length) {
    console.log(`[unit] ${label}：没有文件，跳过`)
    continue
  }
  const { ms, code } = run(files, opts)
  console.log(`\n[unit] ${label}：${files.length} 个文件，${(ms / 1000).toFixed(1)}s，${code ? '失败' : '通过'}`)
  if (code) exitCode = code
}
// 用 exitCode 而不是 exit()：stdout 不是终端（CI 管道）时 exit() 会丢掉最后一行汇总
process.exitCode = exitCode
