#!/usr/bin/env node
/**
 * 各层用例预算检查（spec: Per-layer test budget）。
 *
 * 用法：
 *   node scripts/test-budget.mjs                       # 静态计数（`npm run lint` 用，不跑测试，秒级）
 *   node scripts/test-budget.mjs --check
 *   node scripts/test-budget.mjs --tap <报告> [...]     # CI 跑完单测后复核：累加每份 tap 的 `# tests N`
 *   node scripts/test-budget.mjs --message <文件>       # 用写好的提交说明（本地预检）；默认读 git log -1
 *
 * 超限且提交说明里没有「测试预算:」段时非零退出；把上限抬到冻结基线之上一定非零退出。
 * 同一次全量只统计一次：lint 走静态计数，CI 用已经跑出来的 tap 复核，不重复跑测试。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUDGET_ITEMS,
  BUDGET_NOTE_PREFIX,
  TEST_BUDGET,
  UNIT_CASE_LIMIT,
  budgetVerdict,
  commitMessageFor,
  mergedChainMessages,
  newCasesFromDiff,
  newCasesInSource,
  overBudgets,
  parseBudgetNote,
  pendingTestChanges,
  raisedBudgets,
} from './lib/test-budget.mjs'
import { LAYERS, countCases, countSteps, layerOf, listE2eShards, listUnitTestFiles } from './lib/test-layers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.resolve(root, file), 'utf8').replace(/\r\n/g, '\n')

/** 用例只在这些目录里：探测「未提交改动」和「新增用例」都按这组路径限定（仓库根的生成物不算） */
const TEST_PATHS = ['server', 'shared', 'web/src', 'scripts']

const argv = process.argv.slice(2)
const tapFiles = []
let messageFile = ''
let hasCheck = false
const unknown = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  // 选项的值要跟着选项一起吞掉，不能当成位置参数再报一次
  if (arg === '--check') {
    hasCheck = true
    continue
  }
  if (arg === '--tap' || arg.startsWith('--tap=')) {
    const value = arg === '--tap' ? (argv[++i] ?? '') : arg.slice('--tap='.length)
    if (value) tapFiles.push(value)
    else unknown.push('--tap 后面要跟报告路径')
    continue
  }
  if (arg === '--message' || arg.startsWith('--message=')) {
    messageFile = arg === '--message' ? (argv[++i] ?? '') : arg.slice('--message='.length)
    if (!messageFile) unknown.push('--message 后面要跟说明文件路径')
    continue
  }
  unknown.push(arg)
}
if (unknown.length) {
  console.error(`不认识的参数 ${unknown.join(' ')}：只支持 --check、--tap <报告>、--message <文件>`)
  process.exit(1)
}
// 两种模式不能混用：混用时以前会静默只走 tap（静态的按层判定被丢掉），现在直接报错
if (hasCheck && tapFiles.length) {
  console.error('--check 和 --tap 不能同时用：静态按层计数（lint）与 tap 复核（CI 单测后）是两步，分开跑')
  process.exit(1)
}

/** 跑 git，失败返回空串（没有 git 仓库时预算检查仍然要能跑） */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** 跑 git，只关心成功与否（例如 merge-base --is-ancestor：是祖先返回 0） */
function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** commit 对象里的父提交数：浅克隆时 rev-list 不给父，只能从对象本身数出来 */
function commitParentCount(rev) {
  return git(['cat-file', '-p', rev])
    .split('\n')
    .filter((line) => line.startsWith('parent ')).length
}

/**
 * HEAD 是合并提交时，被合进来那条分支上的说明。
 * 面板和 GitHub 生成的合并提交说明往往只有一行标题，子对话写在提交里的「测试预算:」段要沿合并链往下读：
 * PR merge ref 的 parents[1] 是 dev tip，dev tip 往往又是面板的合并提交，再下一层才是子对话提交（复看 R3）。
 *
 * 只沿第二个父往下、不横向读 `HEAD^1..HEAD^2` 整段：分支上更早 / 兄弟提交里的预算段不属于本次改动，
 * 读了会让本次超预算的新用例静默通过（复看 R2）。多父合并（octopus）同样只取第二个父；
 * 面板和 GitHub 都只产生两父合并。
 */
function mergedCommitMessages() {
  const [, ...parents] = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/)
  if (parents.length < 2) {
    // 普通提交本来就没有两个父，不能提示；浅克隆的合并提交才是「父提交不在本地」（复看 R1）
    if (commitParentCount('HEAD') >= 2 && git(['rev-parse', '--is-shallow-repository']).trim() === 'true')
      console.log(
        '[budget] 浅克隆看不到合并提交的父提交：子提交里的「测试预算:」段读不到，checkout 需要 fetch-depth: 0',
      )
    return []
  }
  return mergedChainMessages({
    tip: parents[1],
    getParents: (sha) => git(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).slice(1),
    // 子分支自己 merge 过 base 时，那一层的第二父是 base 方向：再往下就是上一次改动（复看 R4）
    isBaseSide: (sha) => gitOk(['merge-base', '--is-ancestor', sha, parents[0]]),
    getMessage: (sha) => git(['log', '-1', '--format=%B', sha]),
  })
}

/** 静态计数：按分层扫测试文件源码里的 test( / it(，e2e 扫分片里的 step(，都不执行测试 */
function staticCounts() {
  const counts = { [LAYERS.pure]: 0, [LAYERS.integration]: 0 }
  const files = listUnitTestFiles(root)
  for (const file of files) {
    const source = read(file)
    const { layer } = layerOf(file, source)
    counts[layer] += countCases(source)
  }
  const shards = listE2eShards(root)
  counts.e2eShards = shards.length
  counts.e2eSteps = shards.reduce((n, file) => n + countSteps(read(file)), 0)
  return counts
}

/** 累加 tap 报告里的 `# tests N`：单测分两批跑时会有多条，合并进同一份报告就是总数 */
function tapCaseCount(files) {
  let total = 0
  for (const file of files) {
    const target = path.resolve(root, file)
    if (!existsSync(target)) {
      console.error(`tap 报告不存在：${file}（CI 里先跑单测并把输出存下来）`)
      process.exit(1)
    }
    const hits = [...readFileSync(target, 'utf8').matchAll(/^# tests (\d+)$/gm)].map((m) => Number(m[1]))
    if (!hits.length) {
      console.error(`tap 报告里没有 "# tests N"：${file}（报告被截断或不是 node --test 的输出）`)
      process.exit(1)
    }
    total += hits.reduce((a, b) => a + b, 0)
  }
  return total
}

/** 超预算时列出本次新增的用例位置：已提交/工作区改动看 diff，未跟踪的新文件整份都算新增 */
function collectNewCases() {
  const paths = TEST_PATHS
  const diff = git(['diff', '-U0', 'HEAD', '--', ...paths])
  const cases = newCasesFromDiff(diff)
  // -uall：默认会把新目录折叠成 `?? dir/`，里面的新测试文件就读不到了
  const status = git(['status', '--porcelain', '-uall', '--', ...paths])
  for (const line of status.split('\n')) {
    const m = /^\?\?\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const file = m[1].replace(/\\/g, '/')
    if (!/\.test\.(ts|mjs)$/.test(file)) continue
    cases.push(...newCasesInSource(file, read(file)))
  }
  return cases
}

/**
 * 有没有会影响用例计数的未提交改动（决定能不能把 HEAD 的说明当本次的）。
 * 只看测试目录：CI 里上一步在仓库根留下的 unit-tap.txt 不算改动。
 */
function hasPendingTestChanges() {
  const tracked = git(['diff', '--name-only', 'HEAD', '--', ...TEST_PATHS])
  const untracked = git(['status', '--porcelain', '-uall', '--', ...TEST_PATHS])
    .split('\n')
    .map((line) => /^\?\?\s+(.+)$/.exec(line.trim())?.[1] ?? '')
    .filter(Boolean)
  return pendingTestChanges({ tracked, untracked })
}

const dirty = hasPendingTestChanges()
/**
 * 本次该看的提交说明：`--message` 显式给的优先；工作区有测试改动时 HEAD 的说明属于上一次提交，
 * 拿它当本次说明会静默放行超预算新增。合并提交还要带上被合进来的子提交说明。
 */
function currentCommitMessage() {
  if (messageFile) return read(messageFile)
  if (dirty) return ''
  return commitMessageFor({
    headMessage: git(['log', '-1', '--format=%B']),
    mergedMessages: mergedCommitMessages(),
  })
}
const commitMessage = currentCommitMessage()
const counts = staticCounts()
const raised = raisedBudgets({})
/** 静态按层超限：两种模式都要报（tap 只有总数、分不到层，没法代替按层判定） */
const over = overBudgets({ counts })
const note = parseBudgetNote(commitMessage)
let tapTotal = 0
if (tapFiles.length) {
  tapTotal = tapCaseCount(tapFiles)
  const staticUnit = counts[LAYERS.pure] + counts[LAYERS.integration]
  console.log(`[budget] tap 实测单测用例 ${tapTotal} 条，静态计数 ${staticUnit} 条（差 ${staticUnit - tapTotal}）`)
  if (tapTotal > UNIT_CASE_LIMIT)
    over.push({
      key: 'unitCases',
      label: '单测用例合计',
      count: tapTotal,
      limit: UNIT_CASE_LIMIT,
      excess: tapTotal - UNIT_CASE_LIMIT,
    })
}

console.log(
  `[budget] ${BUDGET_ITEMS.map((i) => `${i.label} ${counts[i.key]} / ${TEST_BUDGET[i.key]}`).join('、')}`,
  tapFiles.length ? `（单测两层合计上限 ${UNIT_CASE_LIMIT}）` : '',
)
for (const item of raised)
  console.log(`[budget] ${item.label} 上限被从 ${item.baseline} 抬到 ${item.limit}：预算只降不升，先把旧用例合并或淘汰`)
for (const item of over) {
  // 同一层可能同时有静态与 tap 两个结论（写法分叉时数字不同），标出来源
  const from = item.key === 'unitCases' ? 'tap' : '静态'
  console.log(`[budget] ${item.label}（${from}） ${item.count} / ${item.limit}（超出 ${item.excess}）`)
}

const ok = budgetVerdict({ raised, over, note })
if (!ok) {
  if (over.length) {
    const cases = collectNewCases()
    if (cases.length) {
      console.log('[budget] 本次新增的用例（要合并或淘汰等量的旧用例）：')
      for (const c of cases) console.log(`  ${c.file}:${c.line}  ${c.text}`)
    }
    if (messageFile)
      console.log('[budget] 提交说明里的「测试预算:」段是空的：写清覆盖了哪个能力、删掉 / 合并了哪些旧用例、靠什么替代')
    else if (dirty)
      console.log(
        '[budget] 工作区有未提交改动，HEAD 的说明属于上一次提交、不能当本次说明；把将要写入的提交说明用 --message <文件> 传进来',
      )
    else
      console.log(
        `[budget] 提交说明缺少「${BUDGET_NOTE_PREFIX}」段：写清覆盖了哪个能力、删掉 / 合并了哪些旧用例、靠什么替代`,
      )
  }
  console.error('[budget] 未通过')
  process.exit(1)
}
if (over.length) console.log(`[budget] 超限但提交说明写明了替代关系：\n${note}`)
console.log('[budget] 通过')
