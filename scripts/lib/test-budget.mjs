/**
 * 各层用例的硬预算（spec: Per-layer test budget）。
 *
 * 「一处定义」：预算数字、冻结基线、判定规则都在这个文件里。检查脚本、CI、文档引用同一份值，
 * 别处不要再写一份数字——要调上限只改这里。
 *
 * 「只降不升」：BUDGET_BASELINE 是首次写入时的快照，TEST_BUDGET 只允许等或更低；
 * 把上限往上调会被检查拦下（要加用例就先合并 / 淘汰等量旧用例，见 spec: Test retirement criteria）。
 */
import { LAYERS } from './test-layers.mjs'

/**
 * 首次写入的基线快照（向上取整到 10 的倍数）。这个对象不随日常调整变化，只用来判「有没有往上抬」。
 * 基线日期：2026-10-27；生成命令：
 *   node scripts/test-layers.mjs --report --out docs/openspec/changes/test-governance-budget-and-parallel-safety/evidence/test-layers.json
 * 首次快照（同日修正一次）：第一版判据漏了 `node:fs/promises` 的异步读写，
 * server/exec/system-prompt.test.ts（5 例）被算进纯函数层；补齐判据后重跑了基线，
 * 集成层从 717 例修正为 722 例（上限 720 → 730）。这是「基线算错后的纠正」，不是放宽上限。
 * 2026-10-27 合并 main 后重算一次：main 带来的角色分层、测试输出重跑等用例让纯函数层到 1507、
 * 集成层到 733；这是上游合入的既有用例，不是本次新增，按合并后的实测重算基线。
 */
export const BUDGET_BASELINE = {
  [LAYERS.pure]: 1510, // 基线实测 1507 例（合并 main 后重算；原 1500）
  [LAYERS.integration]: 740, // 基线实测 733 例（合并 main 后重算；原 730）
  e2eShards: 20, // 基线实测 13 个分片
  e2eSteps: 130, // 基线实测 122 步
}

/** 当前上限：默认等于冻结基线，只在淘汰 / 合并用例后往下调；不能高于 BUDGET_BASELINE */
export const TEST_BUDGET = { ...BUDGET_BASELINE }

/**
 * 预算项：计数键与预算键同名，检查时按键遍历。
 * 加一类新预算（例如资源文件数）时只加一行，检查脚本不用改。
 */
export const BUDGET_ITEMS = [
  { key: LAYERS.pure, label: '纯函数层用例' },
  { key: LAYERS.integration, label: '集成层用例' },
  { key: 'e2eShards', label: 'e2e 分片' },
  { key: 'e2eSteps', label: 'e2e 步骤' },
]

/** 提交说明里允许用这个段说明「超预算的新增换掉了哪些旧用例」（spec: 超限时必须写清替代关系） */
export const BUDGET_NOTE_PREFIX = '测试预算:'

/** 提交说明的分类前缀（见 AGENTS.md「提交说明」）：预算段到这里就结束 */
const COMMIT_SECTIONS = /^(?:新功能|改进|修复|依赖|内部|测试预算)[:：]/

/**
 * 取提交说明里的「测试预算:」段。没有就返回空字符串。
 * 段从 `测试预算:` 那行开始，到空行后的下一个分类前缀或说明结尾为止。
 */
export function parseBudgetNote(message) {
  const lines = String(message ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
  const start = lines.findIndex((l) => l.startsWith(BUDGET_NOTE_PREFIX) || l.startsWith('测试预算：'))
  if (start < 0) return ''
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line && COMMIT_SECTIONS.test(line)) break
    body.push(line)
  }
  const text = [lines[start], ...body].join('\n').trim()
  // 只写了前缀、没写内容的按没写处理：空段说明不了「用什么替代了哪些旧用例」
  return text.replace(/^测试预算[:：]/, '').trim() ? text : ''
}

/**
 * 判定预算。返回 { ok, raised, over, note }：
 * - raised：上限被抬到冻结基线之上（只降不升，写说明也不行）
 * - over：某项计数超过上限；有非空的「测试预算:」段时放行（说明里写了替代关系）
 */
export function checkBudget({ counts, budget = TEST_BUDGET, baseline = BUDGET_BASELINE, commitMessage = '' }) {
  const note = parseBudgetNote(commitMessage)
  const raised = raisedBudgets({ budget, baseline })
  const over = overBudgets({ counts, budget })
  return { ok: budgetVerdict({ raised, over, note }), raised, over, note }
}

/** 各层静态计数超过上限的项；tap 复核时也要用它把「某一层超了」报出来（tap 只有总数，分不到层） */
export function overBudgets({ counts, budget = TEST_BUDGET }) {
  const over = []
  for (const item of BUDGET_ITEMS) {
    const limit = budget[item.key]
    const count = counts[item.key]
    if (typeof count !== 'number') throw new Error(`预算项 ${item.key} 缺计数：count=${count}`)
    if (count > limit) over.push({ key: item.key, label: item.label, count, limit, excess: count - limit })
  }
  return over
}

/**
 * 本次检查该看哪份提交说明：显式传入的优先（调用方已处理）；没有时只有工作区干净才用 HEAD 的说明。
 * 有未提交改动时 HEAD 是上一次提交——它的「测试预算:」段不属于本次改动，
 * 拿它当本次说明会静默放行超预算的新用例。
 */
export function commitMessageFor({ headMessage = '', hasUncommittedChanges = false } = {}) {
  return hasUncommittedChanges ? '' : headMessage
}

/**
 * 有没有会影响用例计数的未提交改动：测试目录里的已跟踪改动，或未跟踪的测试文件。
 * 不能用整仓 `git status`：CI 里前一步会在工作区留下生成物（unit-tap.txt、各种缓存），
 * 那会把「本次提交说明」当成空、合规的超预算提交被挡下（复看 R1）。
 */
export function pendingTestChanges({ tracked = '', untracked = [] } = {}) {
  if (String(tracked).trim()) return true
  return untracked.some((file) => /\.test\.(ts|mjs)$/.test(file))
}

/** 上限被抬到冻结基线之上的项（只降不升）；静态检查与 tap 复核共用 */
export function raisedBudgets({ budget = TEST_BUDGET, baseline = BUDGET_BASELINE }) {
  const raised = []
  for (const item of BUDGET_ITEMS) {
    const limit = budget[item.key]
    const base = baseline[item.key]
    if (typeof limit !== 'number' || typeof base !== 'number')
      throw new Error(`预算项 ${item.key} 缺数字：limit=${limit} baseline=${base}`)
    if (limit > base) raised.push({ key: item.key, label: item.label, limit, baseline: base })
  }
  return raised
}

/**
 * 最终判定只写在这里：上限被抬一定不放行；用例超限时必须有非空的「测试预算:」段。
 * 静态计数和 tap 复核的计数方式不同，但放行规则必须一致，两边都调它。
 */
export function budgetVerdict({ raised, over, note }) {
  return raised.length === 0 && (over.length === 0 || !!note)
}

/** 两层合计上限：tap 报告只有总用例数（不分层），CI 复核时按这个数判 */
export const UNIT_CASE_LIMIT = TEST_BUDGET[LAYERS.pure] + TEST_BUDGET[LAYERS.integration]

/**
 * 从 `git diff -U0` 的输出里取出新增的用例位置（file / line / 源码行）。
 * 超预算时打印这些位置，比只报「多了 3 条」更容易定位到要合并的那几条。
 */
export function newCasesFromDiff(diffText) {
  const out = []
  let file = ''
  let line = 0
  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('+++ ')) {
      // `+++ b/path` 或 `+++ /dev/null`（删文件，没有新增行）
      const target = raw.slice(4).trim()
      file = target === '/dev/null' ? '' : target.replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!file || !raw.startsWith('+') || raw.startsWith('+++')) continue
    if (/^\s*(?:test|it)\s*\(/.test(raw.slice(1))) out.push({ file, line, text: raw.slice(1).trim() })
    line++
  }
  return out
}

/**
 * 未跟踪的新测试文件不在 `git diff` 里：整份都是新增，逐行扫一遍用例调用。
 * 新增文件是最容易把某层顶超预算的情况，不能漏。
 */
export function newCasesInSource(file, sourceText) {
  return String(sourceText ?? '')
    .split('\n')
    .map((text, i) => ({ file, line: i + 1, text: text.trim() }))
    .filter((c) => /^\s*(?:test|it)\s*\(/.test(c.text))
}
