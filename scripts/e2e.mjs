/**
 * 端到端测试总入口：并行跑 scripts/e2e/ 下的各个分片，汇总输出和耗时。
 *
 * 每个分片是一个独立进程：自己的临时数据目录、假 CLI 日志、端口和服务，互不干扰。
 * 分片自己的看门狗和收尾在 harness.mjs 里；这里负责并发、收集输出、退出码和总汇总。
 *
 * 运行：npm run test:e2e
 * 只跑某几个分片：npm run test:e2e -- 03 07（按文件名前缀匹配）
 * 限制并发：AGENT_PANEL_E2E_CONCURRENCY=3 npm run test:e2e
 * 打印每个分片的全部步骤：npm run test:e2e -- --verbose
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fmtDuration } from './lib/duration.mjs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shardDir = path.join(root, 'scripts/e2e')

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const filters = argv.filter((a) => !a.startsWith('-'))
const shards = readdirSync(shardDir)
  .filter((f) => /^\d+-.*\.mjs$/.test(f))
  .sort()
  .filter((f) => !filters.length || filters.some((p) => f.startsWith(p)))
if (!shards.length) {
  console.error('没有匹配的端到端分片：', filters.join(' '))
  process.exit(1)
}

const limit = Math.max(1, Number(process.env.AGENT_PANEL_E2E_CONCURRENCY ?? shards.length))
const timingDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-e2e-timings-'))
const startedAt = Date.now()

console.log(`端到端测试：${shards.length} 个分片，最多同时跑 ${limit} 个\n`)

/** 跑一个分片，收集它的全部输出（成功时只打印摘要，失败时原样打印） */
const runShard = (file) =>
  new Promise((resolve) => {
    const name = file.replace(/^\d+-/, '').replace(/\.mjs$/, '')
    const timingFile = path.join(timingDir, file.replace(/\.mjs$/, '.json'))
    const t0 = Date.now()
    const out = []
    let pending = ''
    const child = spawn(process.execPath, [path.join(shardDir, file)], {
      cwd: root,
      env: { ...process.env, AGENT_PANEL_E2E_TIMINGS: timingFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const collect = (chunk) => {
      pending += chunk
      // 按行收集：超长的一行也不会把内存撑爆（每条日志本来都很短）
      for (;;) {
        const i = pending.indexOf('\n')
        if (i < 0) break
        out.push(pending.slice(0, i))
        pending = pending.slice(i + 1)
      }
    }
    child.stdout.on('data', (d) => collect(d.toString()))
    child.stderr.on('data', (d) => collect(d.toString()))
    child.on('error', (e) => {
      out.push(`启动分片失败：${e}`)
    })
    child.on('close', (code, signal) => {
      if (pending) out.push(pending)
      resolve({ file, name, code: code ?? (signal ? 1 : 0), signal, ms: Date.now() - t0, out })
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
results.sort((a, b) => a.file.localeCompare(b.file))

const elapsed = Date.now() - startedAt
console.log(`\n══════ 汇总（总 ${fmtDuration(elapsed)}）══════`)
for (const r of results) {
  const timing = (() => {
    try {
      return JSON.parse(readFileSync(path.join(timingDir, r.file.replace(/\.mjs$/, '.json')), 'utf8'))
    } catch {
      return null
    }
  })()
  const steps = timing ? `，${timing.steps.length} 步` : ''
  console.log(`${r.code === 0 ? '✓' : '✗'} ${r.name.padEnd(16)} ${fmtDuration(r.ms).padStart(8)}${steps}`)
  // 成功时打印每步耗时（默认只打最慢的 3 步，--verbose 打全部），失败时原样打印全部输出方便定位
  if (r.code === 0) {
    if (timing?.steps && verbose)
      for (const s of timing.steps) console.log(`    ${fmtDuration(s.ms).padStart(7)}  ${s.name}`)
    else if (timing?.top)
      for (const s of timing.top.slice(0, 3)) console.log(`    ${fmtDuration(s.ms).padStart(7)}  ${s.name}`)
  } else {
    console.log(`\n───── ${r.name} 失败，完整输出 ─────`)
    for (const line of r.out) console.log(line)
    console.log(`───── ${r.name} 输出结束 ─────\n`)
  }
}

// 各分片耗时合成一份文件，方便和上一次运行对比（内容与提交无关，已在 .gitignore 里）
const steps = []
for (const r of results) {
  try {
    const timing = JSON.parse(readFileSync(path.join(timingDir, r.file.replace(/\.mjs$/, '.json')), 'utf8'))
    steps.push({ shard: r.name, total: timing.total, steps: timing.steps })
  } catch {}
}
try {
  writeFileSync(
    path.join(root, 'e2e-timings.json'),
    JSON.stringify(
      { total: elapsed, shards: results.map((r) => ({ name: r.name, ms: r.ms, ok: r.code === 0 })), steps },
      null,
      2,
    ),
  )
} catch (e) {
  console.error('写 e2e-timings.json 失败：', e)
}

const failed = results.filter((r) => r.code !== 0)
if (failed.length) {
  console.error(`\n${failed.length} 个分片失败：${failed.map((r) => r.name).join('、')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
