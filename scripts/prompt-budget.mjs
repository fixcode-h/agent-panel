#!/usr/bin/env node
/**
 * 提示词预算（设计稿 designs/Agent写代码能力-提升与扩展分析.md 的 D1）：渲染各内置角色在几种典型情况下交给模型的提示词
 * （shared/prompt/budget.ts），统计字数和估算的 token 数，和基线 scripts/prompt-budget.json 比。
 * 做法照 structure-caps.json：只许变短。变长了 lint 失败——先想想能不能把新规则做成情境规则（shared/hooks/situational.ts），
 * 到用的那一刻再推；确实要加，用 --update --grow 放宽，并在提交说明里写明为什么。
 *
 * 用法：
 *   node scripts/prompt-budget.mjs            # 打印每种情况的字数、token 和基线
 *   node scripts/prompt-budget.mjs --check    # 有超出基线的（或基线里没有的新情况）就失败（npm run lint 跑这个）
 *   node scripts/prompt-budget.mjs --update   # 变短的收紧基线，新情况加进去；变长的不放宽
 *   node scripts/prompt-budget.mjs --update --grow   # 连变长的也按现在的写进基线（提交说明里写原因）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'scripts', 'prompt-budget.json')
const args = process.argv.slice(2)

const { promptBudgetCases } = await tsImport('../shared/prompt/budget.ts', import.meta.url)
const { setLang } = await tsImport('../shared/i18n.ts', import.meta.url)
// 提示词按中文渲染：基线是中文的字数
setLang('zh')
const cases = await promptBudgetCases()
const base = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).cases ?? {}) : {}

const over = cases.filter((c) => base[c.id] !== undefined && c.chars > base[c.id])
const fresh = cases.filter((c) => base[c.id] === undefined)

if (args.includes('--update')) {
  const grow = args.includes('--grow')
  const next = {}
  for (const c of cases) next[c.id] = base[c.id] === undefined || grow ? c.chars : Math.min(base[c.id], c.chars)
  writeFileSync(
    file,
    `${JSON.stringify({ _说明: '提示词字数基线：只许变小，见 scripts/prompt-budget.mjs', cases: next }, null, 2)}\n`,
  )
  const left = grow ? [] : over
  console.log(
    `已更新基线：${cases.length} 种情况${left.length ? `；${left.length} 种变长了，没有放宽（要放宽加 --grow）` : ''}`,
  )
  process.exit(left.length ? 1 : 0)
}

if (!args.includes('--check')) {
  for (const c of cases)
    console.log(
      `${String(c.chars).padStart(6)} 字 ${String(c.tokens).padStart(6)} tok  / ${String(base[c.id] ?? '-').padStart(6)}  ${c.id}`,
    )
}
for (const c of over)
  console.error(`提示词变长了：${c.id} ${c.chars} 字，基线 ${base[c.id]} 字（多了 ${c.chars - base[c.id]}）`)
for (const c of fresh)
  console.error(`基线里没有：${c.id}（${c.chars} 字），跑 node scripts/prompt-budget.mjs --update 加进去`)
if (over.length || fresh.length) {
  console.error(
    '\n先想想新规则能不能做成情境规则（shared/hooks/situational.ts），到用的那一刻再推；确实要加，用 --update --grow 放宽并在提交说明里写明原因',
  )
  process.exit(1)
}
if (args.includes('--check')) console.log(`提示词预算检查通过：${cases.length} 种情况`)
