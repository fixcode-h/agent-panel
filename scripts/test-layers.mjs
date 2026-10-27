#!/usr/bin/env node
/**
 * 测试分层报告：按 scripts/lib/test-layers.mjs 的判据给每个测试文件归层，汇总用例数、行数，
 * 产出可提交的分层基线（`test-layers.json`）。各层用例预算就是按这份基线取整定的
 * （见 scripts/lib/test-budget.mjs），迁移前后对比也看它。
 *
 * 用法：
 *   node scripts/test-layers.mjs --report                     # 只在终端打印摘要
 *   node scripts/test-layers.mjs --report --out <文件>         # 同时写 JSON 基线（父目录不存在会自动建）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INTEGRATION_MARKERS,
  LAYERS,
  countCases,
  countLines,
  countSteps,
  layerOf,
  listE2eShards,
  listUnitTestFiles,
} from './lib/test-layers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}

if (!argv.includes('--report')) {
  console.error('用法：node scripts/test-layers.mjs --report [--out <文件>]')
  process.exit(1)
}

const read = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')

/** 单测文件：一条记录一个文件，层、命中的集成特征、用例数、行数都在这里 */
const files = listUnitTestFiles(root).map((file) => {
  const source = read(file)
  const { layer, markers } = layerOf(file, source)
  return { file, layer, markers, cases: countCases(source), lines: countLines(source) }
})

/** e2e 分片单独统计：它们不进单测的两层预算 */
const e2eShards = listE2eShards(root).map((file) => {
  const source = read(file)
  return { file, steps: countSteps(source), lines: countLines(source) }
})

const totals = {
  [LAYERS.pure]: { files: 0, cases: 0, lines: 0 },
  [LAYERS.integration]: { files: 0, cases: 0, lines: 0 },
  e2e: {
    shards: e2eShards.length,
    steps: e2eShards.reduce((n, s) => n + s.steps, 0),
    lines: e2eShards.reduce((n, s) => n + s.lines, 0),
  },
}
for (const file of files) {
  const t = totals[file.layer]
  if (!t) throw new Error(`不认识的层 ${file.layer}：${file.file}`)
  t.files++
  t.cases += file.cases
  t.lines += file.lines
}

/** 每个集成特征命中了多少个文件：判据是不是在乱命中，看这一行就能发现 */
const markerCounts = Object.fromEntries(
  INTEGRATION_MARKERS.map((m) => [m.id, files.filter((f) => f.markers.includes(m.id)).length]),
)

const out = value('--out')
const report = {
  generatedAt: new Date().toISOString().slice(0, 10),
  command: `node scripts/test-layers.mjs --report${out ? ` --out ${out.replace(/\\/g, '/')}` : ''}`,
  totals,
  markerCounts,
  files,
  e2eShards,
}

const pct = (n) => (n / 1000).toFixed(1)
console.log(
  `[layers] 单测 ${files.length} 个：纯函数层 ${totals.pure.files} 个（${totals.pure.cases} 例 / ${pct(totals.pure.lines)}k 行）、` +
    `集成层 ${totals.integration.files} 个（${totals.integration.cases} 例 / ${pct(totals.integration.lines)}k 行）`,
)
console.log(`[layers] e2e ${totals.e2e.shards} 个分片、${totals.e2e.steps} 步`)
console.log(
  `[layers] 集成特征命中文件数：${INTEGRATION_MARKERS.map((m) => `${m.id} ${markerCounts[m.id]}`).join('、')}`,
)

if (out) {
  const target = path.resolve(root, out)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[layers] 基线已写入 ${path.relative(root, target).split(path.sep).join('/')}`)
}
