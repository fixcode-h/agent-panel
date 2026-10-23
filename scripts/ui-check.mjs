#!/usr/bin/env node
/**
 * 界面检查总入口：用浏览器打开在线演示版（不需要后端），并行跑 scripts/ui/ 下的各个分片，汇总输出和耗时。
 * 检查页面没有报错、关键内容都显示出来、宽屏和手机宽度都没有横向滚动条；截图存到 ui-shots/，
 * 在 CI 里作为附件上传，改了界面可以下载下来对比。
 *
 * 每个分片是一个独立进程：自己的静态服务、浏览器和演示数据，互不干扰（见 scripts/ui/harness.mjs）。
 *
 * 用法：npx vite build --mode demo && node scripts/ui-check.mjs
 * 只跑某几个分片：node scripts/ui-check.mjs 02 06（按文件名前缀匹配）
 * 限制并发：AGENT_PANEL_UI_CONCURRENCY=2 node scripts/ui-check.mjs
 * 打印每个分片的全部步骤：node scripts/ui-check.mjs --verbose
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shardDir = path.join(root, 'scripts/ui')

if (!existsSync(path.join(root, 'dist-demo/index.html'))) {
  console.error('先运行 npx vite build --mode demo')
  process.exit(1)
}

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const filters = argv.filter((a) => !a.startsWith('-'))
const shards = readdirSync(shardDir)
  .filter((f) => /^\d+-.*\.mjs$/.test(f))
  .sort()
  .filter((f) => !filters.length || filters.some((p) => f.startsWith(p)))
if (!shards.length) {
  console.error('没有匹配的界面检查分片：', filters.join(' '))
  process.exit(1)
}

// 只跑部分分片时保留其他分片上次的截图
const shots = path.join(root, 'ui-shots')
if (!filters.length) rmSync(shots, { recursive: true, force: true })
else
  for (const f of shards) {
    const prefix = f.split('-')[0] + '-'
    if (existsSync(shots))
      for (const s of readdirSync(shots)) if (s.startsWith(prefix)) rmSync(path.join(shots, s), { force: true })
  }

// 默认同时跑的分片不超过 CPU 核数：每个分片一个浏览器，挤在一起时页面变慢，一些时序敏感的步骤会偶发失败
const limit = Math.max(
  1,
  Number(process.env.AGENT_PANEL_UI_CONCURRENCY ?? Math.min(shards.length, availableParallelism())),
)
const timingDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-ui-timings-'))
const startedAt = Date.now()
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)
const timingFile = (file) => path.join(timingDir, file.replace(/\.mjs$/, '.json'))
const readTiming = (file) => {
  try {
    return JSON.parse(readFileSync(timingFile(file), 'utf8'))
  } catch {
    return null
  }
}

console.log(`界面检查：${shards.length} 个分片，最多同时跑 ${limit} 个\n`)

/** 跑一个分片，收集它的全部输出（成功时只打印摘要，失败时原样打印） */
const runShard = (file) =>
  new Promise((resolve) => {
    const name = file.replace(/^\d+-/, '').replace(/\.mjs$/, '')
    const t0 = Date.now()
    const out = []
    let pending = ''
    const child = spawn(process.execPath, [path.join(shardDir, file)], {
      cwd: root,
      env: { ...process.env, AGENT_PANEL_UI_TIMINGS: timingFile(file) },
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
      `${r.code === 0 ? '✓' : '✗'} [${i + 1}/${shards.length}] ${name}（${fmtMs(r.ms)}）${r.code === 0 ? '' : `失败，退出码 ${r.code}`}\n`,
    )
  }
}
await Promise.all(Array.from({ length: Math.min(limit, shards.length) }, worker))
results.sort((a, b) => a.file.localeCompare(b.file))

const elapsed = Date.now() - startedAt
console.log(`\n══════ 汇总（总 ${fmtMs(elapsed)}）══════`)
for (const r of results) {
  const timing = readTiming(r.file)
  const count = timing ? `，${timing.steps.length} 张截图` : ''
  console.log(`${r.code === 0 ? '✓' : '✗'} ${r.name.padEnd(16)} ${fmtMs(r.ms).padStart(8)}${count}`)
  // 成功时打印最慢的 3 步（--verbose 打全部），失败时原样打印全部输出方便定位
  if (r.code === 0) {
    const steps = timing?.steps ?? []
    const shown = verbose ? steps : [...steps].sort((a, b) => b.ms - a.ms).slice(0, 3)
    for (const s of shown) console.log(`    ${fmtMs(s.ms).padStart(7)}  ${s.name}`)
  } else {
    console.log(`\n───── ${r.name} 失败，完整输出 ─────`)
    for (const line of r.out) console.log(line)
    console.log(`───── ${r.name} 输出结束 ─────\n`)
  }
}

// 各分片每一步的耗时合成一份文件，方便和上一次运行对比（已在 .gitignore 里）
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
  process.exit(1)
}
console.log('\n界面检查通过，截图在 ui-shots/')
process.exit(0)
