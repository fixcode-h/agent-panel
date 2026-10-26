#!/usr/bin/env node
/**
 * 改动 → 要跑的增量测试：子对话按它的输出只跑受影响的单测文件和界面检查分片，全量交给父对话合并后跑。
 *
 * 用法：
 *   node scripts/changed-tests.mjs [--since <任务基线>] [--json]
 *   node scripts/changed-tests.mjs --files shared/foo.ts,web/src/components/tasks/X.tsx
 *   node scripts/changed-tests.mjs --run          # 按结论直接跑命中的单测（`npm run test:affected`）
 *
 * 不带 --since 时只看工作区（未提交 + 未跟踪）：适合小改动自己确认要跑什么。
 * 带任务基线（开工时记下的 git rev-parse HEAD / 父对话给的 baseRef）时用三点比较，
 * 把从远端合并进来的改动也算上——和提示词里「改动清单」的口径一致。
 *
 * 定位规则和输出格式在 scripts/lib/changed-tests.mjs（纯逻辑，单测覆盖）；依赖图的解析结果
 * 按文件 mtime + size 缓存在 node_modules/.cache/agent-panel/ 下，改过的文件才重新解析。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEPENDENCY_DIRS,
  SOURCE_FILE,
  TEST_FILE,
  parseImports,
  planChangedTests,
  reportChangedTests,
} from './lib/changed-tests.mjs'
import { UI_SHARD_COVERS } from './ui/covers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 参与依赖分析的目录（与定位规则共用一个常量，见 scripts/lib/changed-tests.mjs）；界面的 extension/ 不在其中 */
const SOURCE_DIRS = DEPENDENCY_DIRS
/** 缓存格式变了就丢旧的（字段含义变化时 +1） */
const CACHE_VERSION = 4
const CACHE_FILE = path.join(root, 'node_modules', '.cache', 'agent-panel', 'import-graph.json')

const argv = process.argv.slice(2)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : ''
}
const since = value('--since') || process.env.AGENT_PANEL_BASE_REF || ''
const json = argv.includes('--json')
const explicit = value('--files')
const run = argv.includes('--run')

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：node scripts/changed-tests.mjs [--since <任务基线>] [--files a.ts,b.tsx] [--run] [--json]

输出：受影响（含间接依赖）的单测文件、界面检查分片、是否必须跑全量、直接映射的对比、可直接执行的命令。
--run：按结论直接跑单测（必须全量时跑 npm run test:unit），界面分片只打印命令。`)
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

/** 版本控制里的源文件（天然跳过 node_modules / 构建产物）；限定在参与依赖分析的目录里 */
function listSources() {
  return git('ls-files', '--cached', '--others', '--exclude-standard').filter(
    (f) => SOURCE_FILE.test(f) && SOURCE_DIRS.some((d) => f.startsWith(d)) && existsSync(path.join(root, f)),
  )
}

const readCache = () => {
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    return data?.version === CACHE_VERSION ? (data.files ?? {}) : {}
  } catch {
    // 缓存坏了只是慢一次：重建，不报错（并发写时可能读到写了一半的文件）
    return {}
  }
}

const writeCache = (files) => {
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files }))
    // 先写临时文件再改名：多个子对话同时跑时不留下半截 JSON
    renameSync(tmp, CACHE_FILE)
  } catch {
    // 缓存写不进去（目录只读、磁盘满）不影响本次结果
    rmSync(`${CACHE_FILE}.${process.pid}.tmp`, { force: true })
  }
}

/**
 * 每个源文件 import 了哪些模块。命中缓存（mtime + size 都没变）就不重新解析，
 * 只有改过的文件才读源码。
 */
function loadImports(files) {
  const startedAt = Date.now()
  const cached = readCache()
  const imports = {}
  const next = {}
  let hits = 0
  for (const file of files) {
    const full = path.join(root, file)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    const entry = cached[file]
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size && Array.isArray(entry.specs)) {
      imports[file] = { specs: entry.specs, opaque: Boolean(entry.opaque) }
      next[file] = entry
      hits++
      continue
    }
    const parsed = parseImports(readFileSync(full, 'utf8'))
    imports[file] = parsed
    next[file] = { mtimeMs: stat.mtimeMs, size: stat.size, specs: parsed.specs, opaque: parsed.opaque }
  }
  writeCache(next)
  return { imports, cache: { hits, parsed: files.length - hits, ms: Date.now() - startedAt } }
}

const sources = listSources()
const { imports, cache } = loadImports(sources)

// 测试文件按版本控制里的文件取（天然跳过 node_modules / 构建产物）；未跟踪的新测试也算
const testFiles = sources.filter((f) => TEST_FILE.test(f))
// covers 表里写了但目录里已经没有的分片：不让它变成一条永远跑不起来的命令
const covers = Object.fromEntries(
  Object.entries(UI_SHARD_COVERS).filter(([shard]) => existsSync(path.join(root, 'scripts/ui', `${shard}.mjs`))),
)

const plan = planChangedTests({ changed: changedFiles(), testFiles, sourceFiles: sources, covers, imports })
plan.graph.cache = cache

if (!json) console.log(reportChangedTests(plan))
if (json) console.log(JSON.stringify(plan, null, 2))

if (run) {
  // 必须全量时直接跑全量（高风险区、影响面过宽、图算不出来）；否则只跑命中的文件
  const args = plan.full.tests.required ? [] : ['--files', plan.tests.join(',')]
  if (!plan.changed.length) {
    // 改动已经提交时看不到工作区改动：不静默通过，明确提醒带基线
    console.log('\n改动清单为空：没有跑单测。改动已提交的话带任务基线重跑：npm run test:affected -- --since <基线>')
  } else if (!plan.full.tests.required && !plan.tests.length) {
    console.log('\n没有命中的单测，不跑单测。')
  } else {
    console.log(`\n${plan.full.tests.required ? '跑全量单测' : `跑 ${plan.tests.length} 个命中的单测文件`}：`)
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/unit-tests.mjs'), ...args], {
      cwd: root,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status) process.exitCode = result.status
  }
  if (plan.commands.ui) console.log(`\n界面检查（需要构建，未自动跑）：\n${plan.commands.ui}`)
}
