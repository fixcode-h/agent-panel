#!/usr/bin/env node
/**
 * 测试用例预算（棘轮）：各区的用例数不能超过 scripts/test-budget.json 里记的上限，`npm run lint` 会跑。
 *
 * 为什么：测试只增不减，全量越来越慢、Agent 每次跑测试的成本越来越高，失败重跑也越来越贵。
 * 加用例本身没错，但要是一个有意识的决定：
 * - 超了预算：同一个提交里合并或删掉等量的旧用例（同一行为只断言一处），或者
 *   确实要加时改 scripts/test-budget.json 抬高上限，并在提交说明里写一行「测试预算：为什么要加」；
 * - 低于预算：`node scripts/test-budget.mjs --update` 把上限降到现在的数，只降不升。
 *
 * 数法是静态扫描源码（秒级，不跑测试）：单测数 test( / it( 调用，端到端数 step(，界面检查数 check(。
 * 不追求精确，追求「涨了就看得见」。
 *
 * 用法：
 *   node scripts/test-budget.mjs           # 检查（lint 用）
 *   node scripts/test-budget.mjs --report  # 打印各区用例数和最大的几个文件
 *   node scripts/test-budget.mjs --update  # 把上限降到现在的数（不会抬高）
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listUnitTests } from './lib/test-files.mjs'
import { countCases } from './lib/test-budget.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET_FILE = path.join(root, 'scripts/test-budget.json')
const argv = process.argv.slice(2)

/** 每个区：哪些文件、怎么数 */
function areas() {
  const unit = listUnitTests(root)
  const shard = (dir, re) =>
    readdirSync(path.join(root, dir))
      .filter((f) => re.test(f))
      .map((f) => `${dir}/${f}`)
  return {
    server: { files: unit.filter((f) => f.startsWith('server/')), kind: 'unit' },
    shared: { files: unit.filter((f) => f.startsWith('shared/')), kind: 'unit' },
    web: { files: unit.filter((f) => f.startsWith('web/')), kind: 'unit' },
    scripts: { files: unit.filter((f) => f.startsWith('scripts/')), kind: 'unit' },
    e2e: { files: shard('scripts/e2e', /^\d+-.*\.mjs$/), kind: 'e2e' },
    ui: { files: shard('scripts/ui', /^\d+[a-z]?-.*\.mjs$/), kind: 'ui' },
  }
}

const now = {}
const perFile = []
for (const [name, a] of Object.entries(areas())) {
  now[name] = 0
  for (const f of a.files) {
    const n = countCases(readFileSync(path.join(root, f), 'utf8'), a.kind)
    now[name] += n
    perFile.push({ file: f, n })
  }
}

let budget = {}
try {
  budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')).areas ?? {}
} catch {}

if (argv.includes('--update')) {
  // 只降不升：抬高上限要手改文件，让它在差异里看得见
  const next = Object.fromEntries(
    Object.keys(now).map((k) => [k, budget[k] === undefined ? now[k] : Math.min(budget[k], now[k])]),
  )
  writeFileSync(
    BUDGET_FILE,
    `${JSON.stringify({ note: '测试用例预算，见 scripts/test-budget.mjs。只降不升；要抬高时手改并在提交说明写「测试预算：」', areas: next }, null, 2)}\n`,
  )
  console.log(
    `[budget] 已更新：${Object.entries(next)
      .map(([k, v]) => `${k} ${v}`)
      .join('，')}`,
  )
  process.exit(0)
}

if (argv.includes('--report')) {
  for (const k of Object.keys(now)) console.log(`${k.padEnd(8)} ${String(now[k]).padStart(5)} / ${budget[k] ?? '—'}`)
  console.log('\n用例最多的文件：')
  for (const f of perFile.sort((a, b) => b.n - a.n).slice(0, 10)) console.log(`  ${String(f.n).padStart(4)}  ${f.file}`)
  process.exit(0)
}

const over = Object.keys(now).filter((k) => budget[k] !== undefined && now[k] > budget[k])
const missing = Object.keys(now).filter((k) => budget[k] === undefined)
const slack = Object.keys(now).filter((k) => budget[k] !== undefined && budget[k] - now[k] >= 10)
if (missing.length) {
  console.error(
    `[budget] scripts/test-budget.json 缺这些区的上限：${missing.join('、')}。跑 node scripts/test-budget.mjs --update 补上`,
  )
  process.exitCode = 1
}
if (over.length) {
  console.error(
    `[budget] 测试用例超出预算：${over.map((k) => `${k} ${now[k]}（上限 ${budget[k]}，+${now[k] - budget[k]}）`).join('；')}\n` +
      '  同一个提交里合并或删掉等量的旧用例（同一行为只断言一处）；确实要加就手改 scripts/test-budget.json，' +
      '并在提交说明写一行「测试预算：为什么要加」。',
  )
  process.exitCode = 1
}
if (slack.length && !process.exitCode)
  console.log(
    `[budget] 这些区比上限少了 10 条以上：${slack.map((k) => `${k} ${now[k]} / ${budget[k]}`).join('；')}。` +
      '跑 node scripts/test-budget.mjs --update 把上限降下来',
  )
if (!process.exitCode) console.log('[budget] 测试用例在预算内')
