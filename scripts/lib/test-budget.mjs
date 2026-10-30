/**
 * 用例数报数与「本次新增」判定（ADR 0031，替代 ADR 0024 的硬预算）。
 *
 * 各层用例总数不设上限，只报数：出包时和上次发版对比，涨了多少看得见。
 * 拦的只有一件事：这次改动**净新增**了用例（新增减去删掉，改名、合并不算新增），
 * 提交说明里要有「测试预算:」段写一句为什么加。重复的、被覆盖的旧用例不再要求每次一换一，
 * 定期由「测试验收」的「清理用例」一次列出一批，用户确认后一起删。
 */
import { LAYERS, isE2eShard, isUnitTestPath } from './test-layers.mjs'

/**
 * 报数项：计数键与报数键同名，按键遍历。
 * 加一类新报数（例如资源文件数）时只加一行，脚本不用改。
 */
export const BUDGET_ITEMS = [
  { key: LAYERS.pure, label: '纯函数层用例' },
  { key: LAYERS.integration, label: '集成层用例' },
  { key: 'e2eShards', label: 'e2e 分片' },
  { key: 'e2eSteps', label: 'e2e 步骤' },
]

/** 提交说明里写「为什么要加这些用例」的段 */
export const BUDGET_NOTE_PREFIX = '测试预算:'

/** 提交说明的分类前缀（见 AGENTS.md「提交说明」）：预算段到这里就结束 */
const COMMIT_SECTIONS = /^(?:新功能|改进|修复|依赖|内部|测试预算)[:：]/

/**
 * 取提交说明里的「测试预算:」段。没有就返回空字符串。
 * 段从 `测试预算:` 那行开始，到下一个分类前缀或说明结尾为止。
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
  // 只写了前缀、没写内容的按没写处理：空段说明不了为什么加
  return text.replace(/^测试预算[:：]/, '').trim() ? text : ''
}

/**
 * 有没有会影响用例计数的未提交改动：测试目录里的已跟踪改动，或未跟踪的测试文件。
 * 有的话本次改动就是工作区，HEAD 的说明属于上一次提交、不能当本次的。
 * 不能用整仓 `git status`：CI 里前一步会在工作区留下生成物（unit-tap.txt、各种缓存）。
 */
export function pendingTestChanges({ tracked = '', untracked = [] } = {}) {
  if (String(tracked).trim()) return true
  return untracked.some((file) => /\.test\.(ts|mjs)$/.test(file))
}

/** 测试文件里算一条用例的行：单测的 test( / it(，e2e 分片的 step( */
const caseLine = (file, text) =>
  isE2eShard(file) ? /^\s*(?:await\s+)?step\s*\(/.test(text) : /^\s*(?:test|it)\s*\(/.test(text)

/** 这个路径的用例算不算数：单测文件或 e2e 分片 */
const countsAsTest = (file) => isUnitTestPath(file) || isE2eShard(file)

/**
 * 从 `git diff -U0` 的输出里取出新增和删掉的用例（file / line / 源码行）。
 * 改名是删一条加一条，合并是删两条加一条：净新增 = 新增 - 删掉，用它判定才不会把改名、合并当成新增。
 */
export function diffCases(diffText) {
  const added = []
  const removed = []
  let from = ''
  let to = ''
  let oldLine = 0
  let newLine = 0
  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('--- ')) {
      const p = raw.slice(4).trim()
      from = p === '/dev/null' ? '' : p.replace(/^a\//, '')
      continue
    }
    if (raw.startsWith('+++ ')) {
      // `+++ b/path` 或 `+++ /dev/null`（删文件，没有新增行）
      const p = raw.slice(4).trim()
      to = p === '/dev/null' ? '' : p.replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (raw.startsWith('+')) {
      const text = raw.slice(1)
      if (to && countsAsTest(to) && caseLine(to, text)) added.push({ file: to, line: newLine, text: text.trim() })
      newLine++
    } else if (raw.startsWith('-')) {
      const text = raw.slice(1)
      if (from && countsAsTest(from) && caseLine(from, text))
        removed.push({ file: from, line: oldLine, text: text.trim() })
      oldLine++
    }
  }
  return { added, removed }
}

/**
 * 未跟踪的新测试文件不在 `git diff` 里：整份都是新增，逐行扫一遍用例调用。
 * 新增文件是最容易一下子加很多用例的情况，不能漏。
 */
export function newCasesInSource(file, sourceText) {
  if (!countsAsTest(file)) return []
  return String(sourceText ?? '')
    .split('\n')
    .map((text, i) => ({ file, line: i + 1, text: text.trim() }))
    .filter((c) => caseLine(file, c.text))
}

/**
 * 判定只写在这里：净新增大于 0 时要有非空的「测试预算:」段。
 * 总数多少不管（不设上限）；删掉、合并、改名都放行。
 */
export function newCaseVerdict({ added = [], removed = [], note = '' }) {
  const net = added.length - removed.length
  return { net, ok: net <= 0 || !!note }
}

/** 两份计数逐项对比（出包时和上次发版比）：返回每项的前后值和差 */
export function countDelta(before, after) {
  return BUDGET_ITEMS.map((item) => {
    const was = before?.[item.key] ?? 0
    const now = after[item.key] ?? 0
    return { key: item.key, label: item.label, before: was, after: now, delta: now - was }
  })
}
