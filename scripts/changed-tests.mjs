#!/usr/bin/env node
/**
 * 改动 → 要跑的增量测试：子对话按它的输出只跑命中的单测文件和界面检查分片，全量交给父对话合并后跑。
 *
 * 用法：
 *   node scripts/changed-tests.mjs [--since <任务基线>] [--json]
 *   node scripts/changed-tests.mjs --files shared/foo.ts,web/src/components/tasks/X.tsx
 *
 * 不带 --since 时只看工作区（未提交 + 未跟踪）：适合小改动自己确认要跑什么。
 * 带任务基线（开工时记下的 git rev-parse HEAD / 父对话给的 baseRef）时用三点比较，
 * 把从远端合并进来的改动也算上——和提示词里「改动清单」的口径一致。
 * 定位规则和输出格式在 scripts/lib/changed-tests.mjs（纯逻辑，单测覆盖）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TEST_FILE, planChangedTests, reportChangedTests } from './lib/changed-tests.mjs'
import { UI_SHARD_COVERS } from './ui/covers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : ''
}
const since = value('--since') || process.env.AGENT_PANEL_BASE_REF || ''
const json = argv.includes('--json')
const explicit = value('--files')

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：node scripts/changed-tests.mjs [--since <任务基线>] [--files a.ts,b.tsx] [--json]

输出：要跑的单测文件、要跑的界面检查分片、映射不出来的改动（这些跑全量或交给父对话）、可直接执行的命令。`)
  process.exit(0)
}

/** git 输出按行切开；命令失败时直接报错（不静默当成「没有改动」） */
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 本次改动：任务基线到 HEAD 的完整变更（含合并进来的）+ 工作区改动 + 未跟踪的新文件 */
function changedFiles() {
  if (explicit)
    return explicit
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  const out = new Set()
  if (since) {
    try {
      for (const f of git('diff', '--name-only', `${since}...HEAD`)) out.add(f)
    } catch (error) {
      console.error(`取不到基线 ${since} 的改动清单：${error.message}`)
      process.exit(1)
    }
  }
  for (const f of git('diff', '--name-only', 'HEAD')) out.add(f)
  for (const f of git('ls-files', '--others', '--exclude-standard')) out.add(f)
  return [...out]
}

// 测试文件按版本控制里的文件取（天然跳过 node_modules / 构建产物）；未跟踪的新测试也算
const testFiles = git('ls-files', '--cached', '--others', '--exclude-standard').filter((f) => TEST_FILE.test(f))
// covers 表里写了但目录里已经没有的分片：不让它变成一条永远跑不起来的命令
const covers = Object.fromEntries(
  Object.entries(UI_SHARD_COVERS).filter(([shard]) => existsSync(path.join(root, 'scripts/ui', `${shard}.mjs`))),
)

const plan = planChangedTests({
  changed: changedFiles(),
  testFiles,
  covers,
  readFile: (rel) => {
    try {
      return readFileSync(path.join(root, rel), 'utf8')
    } catch {
      return ''
    }
  },
})

console.log(json ? JSON.stringify(plan, null, 2) : reportChangedTests(plan))
