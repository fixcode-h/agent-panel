#!/usr/bin/env node
/**
 * 用例报数与「本次新增」检查（ADR 0031；替代 ADR 0024 第 4 条的硬预算）。
 *
 * 用法：
 *   node scripts/test-budget.mjs --check                    # lint 用：报各层用例数；本次净新增了用例时要求提交说明有「测试预算:」段
 *   node scripts/test-budget.mjs --check --message <文件>   # 本地预检：用将要写入的提交说明（工作区还没提交时）
 *   node scripts/test-budget.mjs --tap <报告> [...]          # CI 跑完单测后：报 tap 实测用例数，和静态计数对照，不拦
 *   node scripts/test-budget.mjs --report [--since <标签>]   # 出包用：报各层用例数；--since 给了就和那个版本对比（auto = 上一个正式版标签）
 *
 * 总数不设上限：涨了多少靠出包时的对比看见，重复和被覆盖的旧用例由「测试验收」的「清理用例」定期一批清掉。
 * 「本次」是工作区改动（有未提交的测试改动时），否则是 HEAD 这一个提交；合并提交不判
 * （新增用例在被合进来的提交上已经判过，合并提交的 diff 会把对方分支的改动全算进来）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUDGET_ITEMS,
  BUDGET_NOTE_PREFIX,
  countDelta,
  diffCases,
  newCaseVerdict,
  newCasesInSource,
  parseBudgetNote,
  pendingTestChanges,
} from './lib/test-budget.mjs'
import {
  LAYERS,
  countCases,
  countSteps,
  isE2eShard,
  isUnitTestPath,
  layerOf,
  listE2eShards,
  listUnitTestFiles,
} from './lib/test-layers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.resolve(root, file), 'utf8').replace(/\r\n/g, '\n')

/** 用例只在这些目录里：探测「未提交改动」和「新增用例」都按这组路径限定（仓库根的生成物不算） */
const TEST_PATHS = ['server', 'shared', 'web/src', 'scripts']

const argv = process.argv.slice(2)
const tapFiles = []
let messageFile = ''
let since = ''
const modes = new Set()
const unknown = []
/** 选项的值要跟着选项一起吞掉，不能当成位置参数再报一次 */
const valueOf = (arg, name, i) => (arg === name ? [argv[i + 1] ?? '', i + 1] : [arg.slice(name.length + 1), i])
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--check' || arg === '--report') {
    modes.add(arg.slice(2))
    continue
  }
  if (arg === '--tap' || arg.startsWith('--tap=')) {
    const [v, j] = valueOf(arg, '--tap', i)
    i = j
    if (v) tapFiles.push(v)
    else unknown.push('--tap 后面要跟报告路径')
    modes.add('tap')
    continue
  }
  if (arg === '--message' || arg.startsWith('--message=')) {
    const [v, j] = valueOf(arg, '--message', i)
    i = j
    messageFile = v
    if (!v) unknown.push('--message 后面要跟说明文件路径')
    continue
  }
  if (arg === '--since' || arg.startsWith('--since=')) {
    const [v, j] = valueOf(arg, '--since', i)
    i = j
    since = v
    if (!v) unknown.push('--since 后面要跟标签、提交或 auto')
    continue
  }
  unknown.push(arg)
}
if (unknown.length) {
  console.error(
    `不认识的参数 ${unknown.join(' ')}：只支持 --check、--tap <报告>、--report、--message <文件>、--since <标签>`,
  )
  process.exit(1)
}
if (modes.size !== 1) {
  console.error('--check、--tap、--report 选一个：lint 用 --check，CI 单测后用 --tap，出包用 --report')
  process.exit(1)
}
const mode = [...modes][0]

/** 跑 git，失败返回空串（没有 git 仓库时检查仍然要能跑） */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 << 20,
    })
  } catch {
    return ''
  }
}

/** 按分层数一份文件集合：files 是相对路径，load 读出源码（工作区读磁盘，历史版本读 git） */
function countFiles(files, load) {
  const counts = Object.fromEntries(BUDGET_ITEMS.map((i) => [i.key, 0]))
  for (const file of files) {
    const source = load(file)
    if (isE2eShard(file)) {
      counts.e2eShards++
      counts.e2eSteps += countSteps(source)
      continue
    }
    counts[layerOf(file, source).layer] += countCases(source)
  }
  return counts
}

/** 工作区现在的计数：扫测试源码里的 test( / it(，e2e 扫分片里的 step(，不执行测试 */
const workingCounts = () => countFiles([...listUnitTestFiles(root), ...listE2eShards(root)], read)

/** 某个版本的计数：直接读 git 对象，不用切出工作区 */
function countsAt(ref) {
  const files = git(['ls-tree', '-r', '--name-only', ref, '--', ...TEST_PATHS])
    .split('\n')
    .filter((f) => f && (isUnitTestPath(f) || isE2eShard(f)))
  return countFiles(files, (f) => git(['show', `${ref}:${f}`]).replace(/\r\n/g, '\n'))
}

/** 上一个正式版标签（和 scripts/release-notes.mjs 同一口径：HEAD 的祖先里最新的、不带后缀的 v*） */
function previousReleaseTag() {
  const tags = git(['tag', '--merged', 'HEAD', '--sort=-creatordate', '--list', 'v*']).split('\n').filter(Boolean)
  return tags.find((t) => !t.includes('-')) ?? ''
}

const line = (counts) => BUDGET_ITEMS.map((i) => `${i.label} ${counts[i.key]}`).join('、')

if (mode === 'report') {
  const now = workingCounts()
  const ref = since === 'auto' ? previousReleaseTag() : since
  if (!ref) {
    console.log(`[budget] ${line(now)}${since ? '（没有找到上一个正式版标签，不对比）' : ''}`)
    process.exit(0)
  }
  if (!git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim()) {
    console.error(`[budget] 找不到 ${ref}：checkout 需要 fetch-depth: 0 才看得到历史标签`)
    process.exit(1)
  }
  console.log(`[budget] 用例数和 ${ref} 对比（不设上限，只报数）：`)
  for (const d of countDelta(countsAt(ref), now))
    console.log(`  ${d.label}：${d.before} → ${d.after}（${d.delta >= 0 ? '+' : ''}${d.delta}）`)
  process.exit(0)
}

if (mode === 'tap') {
  let total = 0
  for (const file of tapFiles) {
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
  const now = workingCounts()
  const unit = now[LAYERS.pure] + now[LAYERS.integration]
  // 静态和实测差得多，说明有用例是循环里生成的，静态计数口径要改；只报出来，不拦
  console.log(`[budget] tap 实测单测用例 ${total} 条，静态计数 ${unit} 条（差 ${unit - total}）；${line(now)}`)
  process.exit(0)
}

// ---- --check：本次净新增的用例 ----
const tracked = git(['diff', '--name-only', 'HEAD', '--', ...TEST_PATHS])
const untracked = git(['status', '--porcelain', '-uall', '--', ...TEST_PATHS])
  .split('\n')
  .map((l) => /^\?\?\s+(.+)$/.exec(l.trim())?.[1]?.replace(/\\/g, '/') ?? '')
  .filter(Boolean)
const dirty = pendingTestChanges({ tracked, untracked })

/** 本次改动的 diff 和说明；合并提交、没有父提交时返回 null（不判） */
function currentChange() {
  if (dirty) {
    const { added, removed } = diffCases(git(['diff', '-U0', 'HEAD', '--', ...TEST_PATHS]))
    for (const f of untracked)
      if (/\.test\.(ts|mjs)$/.test(f) || isE2eShard(f)) added.push(...newCasesInSource(f, read(f)))
    // 工作区有改动时 HEAD 的说明是上一次提交的，不能拿来当本次的
    return { added, removed, message: messageFile ? read(messageFile) : '', where: '工作区' }
  }
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).slice(1)
  if (parents.length !== 1) return null
  const { added, removed } = diffCases(git(['diff', '-U0', 'HEAD^', 'HEAD', '--', ...TEST_PATHS]))
  return { added, removed, message: messageFile ? read(messageFile) : git(['log', '-1', '--format=%B']), where: 'HEAD' }
}

console.log(`[budget] ${line(workingCounts())}（不设上限，只报数）`)
const change = currentChange()
if (!change) {
  console.log('[budget] HEAD 是合并提交：新增用例在被合进来的提交上判，这里不判')
  console.log('[budget] 通过')
  process.exit(0)
}
const note = parseBudgetNote(change.message)
const { net, ok } = newCaseVerdict({ ...change, note })
console.log(
  `[budget] ${change.where}：新增 ${change.added.length} 条、删掉 ${change.removed.length} 条，净新增 ${net} 条`,
)
if (!ok) {
  console.log('[budget] 新增的用例：')
  for (const c of change.added) console.log(`  ${c.file}:${c.line}  ${c.text}`)
  if (dirty && !messageFile) console.log('[budget] 工作区还没提交：把将要写入的提交说明用 --message <文件> 传进来')
  else
    console.log(`[budget] 提交说明缺少「${BUDGET_NOTE_PREFIX}」段：一句话写清这几条覆盖了什么、为什么现有用例覆盖不到`)
  console.error('[budget] 未通过')
  process.exit(1)
}
if (net > 0) console.log(`[budget] 提交说明写了加用例的理由：\n${note}`)
console.log('[budget] 通过')
