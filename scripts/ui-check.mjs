#!/usr/bin/env node
/**
 * 界面检查总入口：用浏览器打开在线演示版（不需要后端），并行跑 scripts/ui/ 下的各个分片，汇总输出和耗时。
 * 检查页面没有报错、关键内容都显示出来、宽屏和手机宽度都没有横向滚动条；截图存到 ui-shots/，
 * 在 CI 里作为附件上传，改了界面可以下载下来对比。
 *
 * 每个分片是一个独立进程：自己的静态服务、浏览器和演示数据，互不干扰（见 scripts/ui/harness.mjs）。
 *
 * 用法：npx vite build --mode demo && node scripts/ui-check.mjs
 * 只跑某几个分片：node scripts/ui-check.mjs 02 06（按文件名前缀匹配；02 会跑 02、02b、02c 三片）
 * 并发：按 CPU / 内存取小；AGENT_PANEL_UI_CONCURRENCY=2 node scripts/ui-check.mjs 再往下压
 * 只跑 CI 的某一组：node scripts/ui-check.mjs --group a（分组见下面的 CI_GROUP_A）
 * 打印每个分片的全部步骤：node scripts/ui-check.mjs --verbose
 * 每步都截图（默认只拍失败步骤和分片首尾）：SHOTS=all node scripts/ui-check.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fmtDuration } from './lib/duration.mjs'
import { lastFailedShards, retryShards, saveShardResults } from './lib/shard-retry.mjs'
import { writeFlakyReport } from './lib/flaky-report.mjs'
import { concurrencyLine, suggestConcurrency } from './lib/concurrency.mjs'
import { cleanTestEnv, cleanedLine } from './lib/test-env.mjs'
import { UI_SHARD_COVERS } from './ui/covers.mjs'
import { assertDemoBuildFresh } from './lib/demo-build-info.mjs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shardDir = path.join(root, 'scripts/ui')

// 产物不存在，或者源码改过之后没重新构建：打印变了的文件并失败，不拿旧产物跑出假结果
assertDemoBuildFresh(root)

/**
 * CI 把界面检查拆到两台 runner（.github/workflows/ci.yml 的 ui 矩阵）：一台 4 核机器上所有分片挤在一起
 * 是 CPU 打满的，拆开后各跑一半。a 组按完整文件名列出，其余分片（包括以后新加、还没登记的）都归 b 组，
 * 所以不会有分片两组都不跑。按 ui-timings.json 的分片耗时配平：分片耗时变化大时调整 a 组。
 */
const CI_GROUP_A = ['02-task', '02b-subagent', '05-settings', '06-settings-agent', '07-projects', '10-toast']
const inCiGroup = (group, file) => CI_GROUP_A.includes(file.replace(/\.mjs$/, '')) === (group === 'a')

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const groupAt = argv.indexOf('--group')
const group = groupAt >= 0 ? argv[groupAt + 1] : null
if (groupAt >= 0 && !['a', 'b'].includes(group)) {
  console.error(`--group 只能是 a 或 b（实际 ${group ?? '空'}）`)
  process.exit(1)
}
const filters = argv.filter((a, i) => !a.startsWith('-') && !(groupAt >= 0 && i === groupAt + 1))
// 分片文件名：01、02 这类两/三位编号，也可以是 02b、02c（同一个主题拆成几片）
const SHARD_FILE = /^\d+[a-z]?-.*\.mjs$/
const allShards = readdirSync(shardDir)
  .filter((f) => SHARD_FILE.test(f))
  .sort()
// --failed：只跑上一次还失败的分片（改完复测用）；--no-retry：失败不重跑
const onlyFailed = argv.includes('--failed')
const retry = !argv.includes('--no-retry')
const last = onlyFailed ? lastFailedShards(root, 'ui') : null
if (onlyFailed && !last?.length) {
  console.log(last ? '上一次没有失败的界面检查分片，不用重跑' : '没有上一次的界面检查结果，先跑一次全量')
  process.exit(0)
}
const shards = allShards
  .filter((f) => !filters.length || filters.some((p) => f.startsWith(p)))
  .filter((f) => !group || inCiGroup(group, f))
  .filter((f) => !last || last.includes(f))
if (!shards.length) {
  console.error('没有匹配的界面检查分片：', filters.join(' '))
  process.exit(1)
}

// 只跑部分分片时保留其他分片上次的截图
const shots = path.join(root, 'ui-shots')
// --failed 只跑几片：和按前缀筛选一样只清这几片的旧截图，别的分片的截图留着
if (!filters.length && !onlyFailed) rmSync(shots, { recursive: true, force: true })
else
  for (const f of shards) {
    const prefix = f.split('-')[0] + '-'
    if (existsSync(shots))
      for (const s of readdirSync(shots)) if (s.startsWith(prefix)) rmSync(path.join(shots, s), { force: true })
  }

// 同时跑的分片：CPU、可用内存（每片一个浏览器约 500M）和分片数取小，挤在一起时页面变慢，一些时序敏感的步骤会偶发失败；
// AGENT_PANEL_UI_CONCURRENCY 只能再往下压（scripts/lib/concurrency.mjs）
const conc = suggestConcurrency({
  kind: 'ui',
  units: shards.length,
  env: process.env.AGENT_PANEL_UI_CONCURRENCY,
  envName: 'AGENT_PANEL_UI_CONCURRENCY',
})
const limit = conc.value
// 分片继承的环境：去掉会把服务指到真实数据目录、改 git 行为的变量（scripts/lib/test-env.mjs）
const { env: shardEnv, removed } = cleanTestEnv()
const timingDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-ui-timings-'))
const startedAt = Date.now()

const timingFile = (file) => path.join(timingDir, file.replace(/\.mjs$/, '.json'))
const readTiming = (file) => {
  try {
    return JSON.parse(readFileSync(timingFile(file), 'utf8'))
  } catch {
    return null
  }
}

/**
 * scripts/ui/covers.mjs 登记的分片要和真实分片文件对上：
 * 新加一片忘了登记，改了它断言的源码时 changed-tests 映射不到，会被当成「没覆盖」而漏跑；
 * 改名后旧登记残留，它以为那一页还有检查。
 * 只提示不失败：加片和补映射可以分两次提交，别为了让检查通过先凑一行假映射。
 */
const registered = new Set(Object.keys(UI_SHARD_COVERS))
const unregistered = allShards.map((f) => f.replace(/\.mjs$/, '')).filter((name) => !registered.has(name))
const stale = [...registered].filter((name) => !allShards.includes(`${name}.mjs`))
if (unregistered.length || stale.length) {
  console.log('提示：界面检查分片和 scripts/ui/covers.mjs 的登记对不上（不影响本次结果）')
  if (unregistered.length)
    console.log(`  没登记：${unregistered.join('、')}（改到它们的源码时映射不出来，会漏跑这一片）`)
  if (stale.length) console.log(`  登记了但已经没有这个文件：${stale.join('、')}`)
  console.log('')
}

console.log(`界面检查：${shards.length} 个分片，最多同时跑 ${limit} 个`)
console.log(concurrencyLine('[ui]', conc))
if (removed.length) console.log(cleanedLine('[ui]', removed))
console.log('')

/** 跑一个分片，收集它的全部输出（成功时只打印摘要，失败时原样打印） */
const runShard = (file) =>
  new Promise((resolve) => {
    const name = file.replace(/^\d+-/, '').replace(/\.mjs$/, '')
    const t0 = Date.now()
    const out = []
    let pending = ''
    const child = spawn(process.execPath, [path.join(shardDir, file)], {
      cwd: root,
      env: {
        ...shardEnv,
        AGENT_PANEL_UI_TIMINGS: timingFile(file),
        AGENT_PANEL_UI_SHARD_ID: name,
        // --verbose 看每一步的样子，等于 SHOTS=all（用户自己在环境里设的 SHOTS 不被覆盖）
        ...(verbose ? { SHOTS: 'all' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const collect = (chunk) => {
      pending += chunk
      for (;;) {
        const i = pending.indexOf('\n')
        if (i < 0) break
        out.push(pending.slice(0, i))
        pending = pending.slice(i + 1)
      }
    }
    child.stdout.on('data', (d) => collect(d.toString()))
    child.stderr.on('data', (d) => collect(d.toString()))
    child.on('error', (e) => out.push(`启动分片失败：${e}`))
    child.on('close', (code, signal) => {
      if (pending) out.push(pending)
      resolve({ file, name, code: code ?? (signal ? 1 : 0), ms: Date.now() - t0, out })
    })
  })

const results = []
let next = 0
const worker = async () => {
  for (;;) {
    const i = next++
    if (i >= shards.length) return
    const file = shards[i]
    const name = file.replace(/^\d+-/, '').replace(/\.mjs$/, '')
    process.stdout.write(`▶ [${i + 1}/${shards.length}] 开始：${name}\n`)
    const r = await runShard(file)
    results.push(r)
    process.stdout.write(
      `${r.code === 0 ? '✓' : '✗'} [${i + 1}/${shards.length}] ${name}（${fmtDuration(r.ms)}）${r.code === 0 ? '' : `失败，退出码 ${r.code}`}\n`,
    )
  }
}
await Promise.all(Array.from({ length: Math.min(limit, shards.length) }, worker))
// 失败的分片串行再跑一次（scripts/lib/shard-retry.mjs）：只重跑失败的，不整轮重来
const retried = retry ? await retryShards(results, runShard) : { results, flaky: [], detail: [] }
// 抖动报告整份替换这一类（scripts/lib/flaky-report.mjs）：没有抖动就清掉上一次留下的
writeFlakyReport(root, 'ui', retried.detail, shards.length)
results.splice(0, results.length, ...retried.results)
results.sort((a, b) => a.file.localeCompare(b.file))
saveShardResults(
  root,
  'ui',
  results.filter((r) => r.code !== 0).map((r) => r.file),
  retried.flaky,
)
if (retried.flaky.length)
  console.log(
    `\n⚠ 抖动（第一次失败、重跑通过）：${retried.flaky.join('、')}。要找出时序或共享状态的原因，不要靠重跑兜着`,
  )

const elapsed = Date.now() - startedAt
console.log(`\n══════ 汇总（总 ${fmtDuration(elapsed)}）══════`)
for (const r of results) {
  const timing = readTiming(r.file)
  const count = timing ? `，${timing.steps.length} 步` : ''
  console.log(`${r.code === 0 ? '✓' : '✗'} ${r.name.padEnd(16)} ${fmtDuration(r.ms).padStart(8)}${count}`)
  // 成功时打印最慢的 3 步（--verbose 打全部），失败时原样打印全部输出方便定位
  if (r.code === 0) {
    const steps = timing?.steps ?? []
    const shown = verbose ? steps : [...steps].sort((a, b) => b.ms - a.ms).slice(0, 3)
    for (const s of shown) console.log(`    ${fmtDuration(s.ms).padStart(7)}  ${s.name}`)
  } else {
    console.log(`\n───── ${r.name} 失败，完整输出 ─────`)
    for (const line of r.out) console.log(line)
    console.log(`───── ${r.name} 输出结束 ─────\n`)
  }
}

// 各分片每一步的耗时合成一份文件，方便和上一次运行对比（已在 .gitignore 里）。
// 这是每次运行自己的快照，不是分片清单也不是基线：分片有哪些以 scripts/ui/ 下的文件和 covers.mjs 的登记为准
try {
  writeFileSync(
    path.join(root, 'ui-timings.json'),
    JSON.stringify(
      {
        total: elapsed,
        shards: results.map((r) => ({ name: r.name, ms: r.ms, ok: r.code === 0, steps: readTiming(r.file)?.steps })),
      },
      null,
      2,
    ),
  )
} catch (e) {
  console.error('写 ui-timings.json 失败：', e)
}

const failed = results.filter((r) => r.code !== 0)
if (failed.length) {
  console.error(`\n${failed.length} 个分片失败：${failed.map((r) => r.name).join('、')}`)
  console.error(`改完后只复测失败的分片：node scripts/ui-check.mjs --failed`)
  process.exit(1)
}
console.log('\n界面检查通过，截图在 ui-shots/')
process.exit(0)
