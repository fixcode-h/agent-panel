/**
 * 改动 → 要跑的测试：子对话按这里只跑命中影响的单测文件和界面检查分片，全量交给父对话合并后跑。
 *
 * 这里是纯逻辑（不碰文件系统、不跑命令）：CLI 用 scripts/changed-tests.mjs 收集文件清单和读源码，
 * 单测用固定的小文件树钉住定位规则。
 *
 * 口径是**影响面**而不是直接映射：改 `shared/task.ts` 时，`task.test.ts` 只是很小一部分，
 * 真正可能被影响的是所有（间接）依赖它的文件。所以：
 * 1. 建 import 依赖图（scripts/lib/import-graph.mjs），从改动文件求反向依赖闭包
 * 2. 闭包里的测试文件、以及闭包里每个源文件的同名测试都要跑
 * 3. 测试通过 import 间接依赖闭包里的文件时也算命中（图不完整时的兜底）
 * 4. 闭包里的界面文件按 scripts/ui/covers.mjs 映射到界面检查分片
 * 5. 改动落在高风险区（执行链路、CLI 解析、内置模板、数据 schema）时直接建议全量 + e2e，
 *    不硬做增量；影响面过宽时同样建议全量
 * 6. 算不出来时（解析不了的 import、非字面量的 import）**明确列出来**并建议全量，不静默少跑
 *
 * 直接映射（同名 / 直接 import / 同目录）仍然保留在 `planDirectTests` 里：报告里给出两个口径的
 * 对比，让人看得出影响面分析多覆盖了什么、值不值。
 */
import path from 'node:path'

import {
  SOURCE_FILE,
  TEST_FILE,
  buildImportGraph,
  forwardClosure,
  moduleKey,
  norm,
  resolveSpec,
  reverseClosure,
} from './import-graph.mjs'

export { SOURCE_FILE, TEST_FILE, importsOf, moduleKey, parseImports, resolveSpec } from './import-graph.mjs'

const STRIP_EXT = /\.(?:[cm]?[jt]sx?)$/
/** 同名测试的写法 */
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.test.mjs', '.spec.ts', '.spec.mjs']

/** 同目录回退的上限：一个目录里的测试多到这个数，说明它是公共目录（web/src/lib、shared/ 根下），
 * 跑它全部已经等于跑大半个模块，不该再冒充「增量」。超过就报「映射不出来」，由调用方跑全量或交给父对话。
 */
export const SAME_DIR_FALLBACK_MAX = 6

/**
 * 参与依赖图的目录：CLI 只扫这几棵目录，`missing-source`（文件被删 / 改名）也只对它们里的文件算。
 * 目录外的源码（`extension/*.js`、根目录的 `vite.config.ts`）不参与单测，改它们不该强制全量。
 */
export const DEPENDENCY_DIRS = ['shared/', 'server/', 'web/src/', 'scripts/']

/** 这个文件是不是在参与依赖图的目录里 */
export const inDependencyDirs = (file) => DEPENDENCY_DIRS.some((dir) => norm(file).startsWith(dir))

/**
 * 命中面超过全量的这个比例就不再叫「增量」了：说明这次改的东西几乎影响一切，
 * 直接告诉调用方跑全量，比列一长串文件更省时间也更不容易漏。
 * 量太小时不看比例（下面两个最小值）：小项目里 1/1 也是 100%，不能因此建议全量。
 */
export const FULL_COVERAGE_RATIO = 0.6
export const FULL_COVERAGE_MIN_TESTS = 20
export const FULL_COVERAGE_MIN_SHARDS = 8

/**
 * 高风险区：这些地方一改，行为面覆盖到所有 CLI / 所有工作流 / 所有落盘数据，
 * 增量测试挑不出可靠的范围，直接建议全量单测 + e2e。加新的高风险目录时只加一行。
 */
export const HIGH_RISK_AREAS = [
  { path: 'shared/engine.ts', why: '执行引擎' },
  { path: 'shared/schema.ts', why: '数据 schema' },
  { dir: 'server/exec/', why: 'CLI 执行链路与输出解析' },
  { dir: 'shared/clis/', why: 'CLI 定义与输出解析' },
  { dir: 'shared/builtin/', why: '内置角色与工作流模板' },
]

/** 改动文件落在哪个高风险区（没命中返回空） */
export function highRiskOf(file) {
  const f = norm(file)
  for (const area of HIGH_RISK_AREAS) {
    const hit = area.path ? f === area.path : f.startsWith(area.dir)
    if (hit) return area
  }
  return undefined
}

/** 一个改动文件命中了哪些界面检查分片（分片名 → 覆盖前缀表，以 / 结尾按目录前缀算） */
export function shardsFor(file, covers = {}) {
  const f = norm(file)
  const hits = []
  for (const [shard, prefixes] of Object.entries(covers)) {
    if (prefixes.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))) hits.push(shard)
  }
  return hits
}

/** 界面检查本身（harness、covers、总入口）改了就全部分片都要跑 */
const isUiRunner = (file) =>
  file === 'scripts/ui-check.mjs' ||
  file === 'scripts/ui/harness.mjs' ||
  file === 'scripts/ui/covers.mjs' ||
  // 任务页三片共用的开场和操作（不是分片，不在 covers 的分片表里）
  file === 'scripts/ui/task-page.mjs'

const isUiShardScript = (file) => file.startsWith('scripts/ui/') && file.endsWith('.mjs')

/** 一个代码文件的同名测试（没有返回空） */
function sameNameTests(file, testSet) {
  const base = norm(file).replace(STRIP_EXT, '')
  return TEST_SUFFIXES.map((s) => base + s).filter((t) => testSet.has(t))
}

/** 同目录下的测试（给「影响面里一个测试都没命中」的改动兜底） */
function sameDirTests(file, sortedTests) {
  const dir = path.posix.dirname(norm(file))
  return sortedTests.filter((t) => path.posix.dirname(t) === dir)
}

const has = (set, file) => set.has(norm(file))

/** 解析好的 import 表：支持 Map 和普通对象两种写法（CLI 从 JSON 缓存读出来是对象） */
const entryOf = (imports, file) => (imports instanceof Map ? imports.get(file) : imports?.[norm(file)])
const specsOf = (imports, file) => entryOf(imports, file)?.specs ?? []
const isOpaque = (imports, file) => Boolean(entryOf(imports, file)?.opaque)

/**
 * 旧口径（直接映射）：同名测试 → 直接 import 它的测试 → 同目录回退。
 * 只用于报告里的对比，不参与增量决定。
 */
export function planDirectTests({ changed, testFiles, covers = {}, imports }) {
  const files = [...new Set((changed ?? []).map(norm))].filter(Boolean)
  const testSet = new Set((testFiles ?? []).map(norm))
  const sortedTests = [...testSet].sort()
  const tests = new Set()
  const shardHits = new Set()
  for (const file of files) {
    if (isUiRunner(file)) {
      for (const shard of Object.keys(covers)) shardHits.add(shard)
      continue
    }
    if (isUiShardScript(file)) {
      const name = path.posix.basename(file).replace(/\.mjs$/, '')
      if (covers[name]) shardHits.add(name)
      continue
    }
    if (TEST_FILE.test(file)) {
      tests.add(file)
      continue
    }
    if (!SOURCE_FILE.test(file)) continue
    const hit = new Set(sameNameTests(file, testSet))
    if (!hit.size && imports) {
      const key = moduleKey(file)
      for (const t of sortedTests)
        if (specsOf(imports, t).some((spec) => moduleKey(resolveSpec(spec, t)) === key)) hit.add(t)
    }
    if (!hit.size) {
      const sameDir = sameDirTests(file, sortedTests)
      if (sameDir.length && sameDir.length <= SAME_DIR_FALLBACK_MAX) sameDir.forEach((t) => hit.add(t))
    }
    hit.forEach((t) => tests.add(t))
    shardsFor(file, covers).forEach((s) => shardHits.add(s))
  }
  return { tests: [...tests].sort(), shards: [...shardHits].sort() }
}

/**
 * 新口径（影响面分析）：`sourceFiles` 是扫描到的源文件（含测试），`imports` 是它们解析好的
 * import 列表（`{ 文件: { specs, opaque } }`，CLI 从缓存里给）。不传时图只有测试文件，
 * 等价于「只看测试与改动的关系」。
 */
export function planChangedTests({ changed, testFiles, sourceFiles, covers = {}, imports }) {
  const files = [...new Set((changed ?? []).map(norm))].filter(Boolean)
  const testSet = new Set((testFiles ?? []).map(norm))
  const sortedTests = [...testSet].sort()
  const tests = new Set()
  const shardHits = new Set()
  const unmapped = []
  const ignored = []
  /** 强制全量的理由：scope 说清影响的是单测还是界面检查（两样都影响就写 both） */
  const fullReasons = []
  const addFull = (code, scope, detail) => fullReasons.push({ code, scope, detail })
  const fullOf = (scope) => {
    const reasons = fullReasons.filter((r) => r.scope === scope || r.scope === 'both')
    return { required: reasons.length > 0, reasons }
  }
  // 图节点：扫描到的源文件 + 测试文件；改了图外的文件（新文件、别的目录）也要能建图
  const graphFiles = [...new Set([...(sourceFiles ?? []).map(norm), ...sortedTests, ...files])]
    .filter((f) => SOURCE_FILE.test(f))
    .sort()
  const graph = buildImportGraph({
    files: graphFiles,
    load: (f) => ({ specs: specsOf(imports, f), opaque: isOpaque(imports, f) }),
  })

  // 改动里参与依赖分析的代码文件（文档、配置不建图）
  const codeChanged = files.filter((f) => SOURCE_FILE.test(f))
  // 已删除 / 改名 / 不在扫描范围的文件：图里没有它，依赖它的文件反查不到，只能保守全量。
  // （旧口径按路径文本比对，删掉文件也能命中依赖它的测试，换成真实文件匹配后要补上这条）
  // 只对参与依赖图的目录算：`extension/`、`vite.config.ts` 这类本来就不进图，删改它们和单测无关。
  if (sourceFiles) {
    const scanned = new Set(sourceFiles.map(norm))
    const missing = codeChanged.filter((f) => inDependencyDirs(f) && !scanned.has(f))
    if (missing.length)
      addFull(
        'missing-source',
        'tests',
        `${missing.join('、')} 不在扫描到的源文件里（已删除 / 改名），依赖它的文件无法从 import 图反查，跑全量单测`,
      )
  }
  const closure = reverseClosure({ reverse: graph.reverse, changed: codeChanged })

  for (const file of files) {
    // 界面检查自己的脚本：改哪个分片跑哪个；改公共部分跑全部分片
    if (isUiRunner(file)) {
      for (const shard of Object.keys(covers)) shardHits.add(shard)
      continue
    }
    if (isUiShardScript(file)) {
      const name = path.posix.basename(file).replace(/\.mjs$/, '')
      if (covers[name]) shardHits.add(name)
      // 新加的分片没登记进 covers：不跑它等于漏了这次改动，明确说出来
      else unmapped.push({ file, reason: '界面检查分片没有登记到 scripts/ui/covers.mjs，跑全量的界面检查并补上映射' })
      continue
    }
    // 测试文件本身：直接跑它
    if (TEST_FILE.test(file)) {
      tests.add(file)
      continue
    }
    // 高风险区先判：`shared/clis/**` 这类是 json，不属于源码文件，但改了它们同样要全量
    const risk = highRiskOf(file)
    if (risk && !fullReasons.some((r) => r.code === 'high-risk'))
      addFull('high-risk', 'tests', `${file} 在「${risk.why}」高风险区，增量挑不出可靠范围，跑全量单测 + e2e`)
    if (!SOURCE_FILE.test(file) || !inDependencyDirs(file)) {
      // 目录外的源码（extension/、vite.config.ts）不参与单测，当作不涉及测试的改动
      ignored.push(file)
      continue
    }

    const shards = shardsFor(file, covers)
    shards.forEach((s) => shardHits.add(s))
    // 界面改动按分片判断：命中单测不等于界面也被覆盖了（通用组件常常有单测但没有分片映射）
    if (file.startsWith('web/src/') && !shards.length) {
      unmapped.push({
        file,
        reason: '没有对应的界面检查分片（通用组件、演示数据这类会影响所有页面），跑全量的界面检查',
      })
    }
    // 改动文件自己的同名测试一定要跑（它就是针对这个文件的）
    sameNameTests(file, testSet).forEach((t) => tests.add(t))
  }

  // 影响面：闭包里的测试 + 闭包里每个源文件的同名测试
  for (const file of closure) {
    if (testSet.has(file)) tests.add(file)
    else if (SOURCE_FILE.test(file) && !TEST_FILE.test(file)) sameNameTests(file, testSet).forEach((t) => tests.add(t))
    // 闭包里的界面文件（间接受影响）照样要跑它所在的分片
    if (file.startsWith('web/src/')) shardsFor(file, covers).forEach((s) => shardHits.add(s))
  }
  // 测试通过 import 间接依赖闭包里的文件：图不完整时（例如只在测试里出现的路径）也要认
  if (imports) {
    for (const t of sortedTests) {
      if (tests.has(t)) continue
      const reach = forwardClosure({ edges: graph.edges, file: t })
      if ([...reach].some((f) => has(closure, f))) tests.add(t)
    }
  }

  // 还是没有测试的改动文件：同目录回退（上限内），否则明确报映射不出来
  for (const file of codeChanged) {
    if (TEST_FILE.test(file)) continue
    // 这个改动文件是否已经落在某个要跑的测试的依赖闭包里：是就不用再回退
    const covered = [...tests].some((t) => forwardClosure({ edges: graph.edges, file: t }).has(norm(file)))
    if (covered) continue
    const sameDir = sameDirTests(file, sortedTests)
    if (sameDir.length && sameDir.length <= SAME_DIR_FALLBACK_MAX) {
      sameDir.forEach((t) => tests.add(t))
      continue
    }
    if (file.startsWith('web/src/') && shardsFor(file, covers).length) continue
    if (unmapped.some((u) => u.file === file)) continue
    unmapped.push({
      file,
      reason: imports
        ? '影响面里没有测试命中它（没有同名测试、没有测试依赖它，同目录测试太多或没有），跑全量单测或交给父对话'
        : '没有找到对应的单测文件（同名 / 反向 import 没有命中，同目录测试太多或没有），跑全量单测或交给父对话',
    })
  }

  // 图算不出来：非测试文件里有解析失败的 import 或非字面量的动态 import，说明依赖关系可能漏了
  const gaps = [...graph.unresolved, ...graph.opaque.map((o) => ({ from: o.from, spec: '' }))].filter(
    (g) => !TEST_FILE.test(g.from),
  )
  const changedKeys = new Set(codeChanged.map((f) => moduleKey(f)))
  const relevantGaps = gaps.filter((g) => has(closure, g.from) || (g.spec && changedKeys.has(moduleKey(g.spec))))
  if (relevantGaps.length)
    addFull(
      'graph-gap',
      'both',
      `有 ${relevantGaps.length} 处 import 解析不出来（${relevantGaps
        .slice(0, 3)
        .map((g) => (g.spec ? `${g.from} → ${g.spec}` : `${g.from} 用了非字面量的 import`))
        .join('；')}），依赖闭包不完整，跑全量`,
    )

  const testList = [...tests].sort()
  const shardList = [...shardHits].sort()
  const totalTests = sortedTests.length
  const totalShards = Object.keys(covers).length
  if (totalTests >= FULL_COVERAGE_MIN_TESTS && testList.length / totalTests >= FULL_COVERAGE_RATIO)
    addFull(
      'wide-tests',
      'tests',
      `影响面覆盖 ${testList.length}/${totalTests} 个单测文件（超过 ${Math.round(
        FULL_COVERAGE_RATIO * 100,
      )}%），已经接近全量，直接跑 \`npm run test:unit\` 更省事`,
    )
  if (totalShards >= FULL_COVERAGE_MIN_SHARDS && shardList.length / totalShards >= FULL_COVERAGE_RATIO)
    addFull(
      'wide-shards',
      'ui',
      `影响面覆盖 ${shardList.length}/${totalShards} 个界面分片（超过 ${Math.round(
        FULL_COVERAGE_RATIO * 100,
      )}%），直接跑全量界面检查更省事`,
    )

  const direct = planDirectTests({ changed: files, testFiles: sortedTests, covers, imports })
  const fullTests = fullOf('tests')
  const fullUi = fullOf('ui')
  return {
    changed: files,
    tests: testList,
    shards: shardList,
    unmapped,
    ignored,
    full: { tests: fullTests, ui: fullUi },
    e2e: fullReasons.some((r) => r.code === 'high-risk'),
    direct,
    graph: {
      files: graph.files.size,
      edges: [...graph.edges.values()].reduce((n, deps) => n + deps.length, 0),
      closure: closure.size,
      // 闭包里除改动文件本身之外的部分：这次多带出来的「间接依赖者」
      indirect: closure.size - codeChanged.filter((f) => graph.files.has(f)).length,
      unresolved: graph.unresolved.length,
      opaque: graph.opaque.length,
    },
    commands: {
      // 必须全量时给全量命令：否则报告里同时出现「必须全量」和一条增量命令，照抄就缩回增量了
      tests: fullTests.required
        ? 'npm run test:unit'
        : testList.length
          ? `node scripts/unit-tests.mjs --files ${testList.join(',')}`
          : '',
      // 界面检查的产物必须是这次源码构建出来的（ui-check 会校验），所以先构建再按分片跑
      ui: fullUi.required
        ? 'npx vite build --mode demo && node scripts/ui-check.mjs'
        : shardList.length
          ? `npx vite build --mode demo && node scripts/ui-check.mjs ${shardList.map((s) => s.replace(/\.mjs$/, '')).join(' ')}`
          : '',
    },
  }
}

/** 粗估单测耗时：一个文件在默认并发下的平均开销（含 tsx 启动和导入），只用来对比两个口径的量级 */
const UNIT_SECONDS_PER_FILE = 0.4

const estText = (count) => (count ? `约 ${Math.max(1, Math.round(count * UNIT_SECONDS_PER_FILE))}s` : '0s')

/** 给人看的输出：先说结论（跑哪几条、要不要全量），再列清单，最后是两个口径的对比 */
export function reportChangedTests(plan) {
  const lines = []
  const codeCount = plan.changed.filter((f) => SOURCE_FILE.test(f) || isUiShardScript(f) || isUiRunner(f)).length
  lines.push(`改动 ${plan.changed.length} 个文件（其中 ${codeCount} 个代码文件）`)
  if (plan.graph) {
    const cache = plan.graph.cache
    lines.push(
      `影响面：反向依赖闭包 ${plan.graph.closure} 个文件（依赖图 ${plan.graph.files} 个文件 / ${plan.graph.edges} 条 import）`,
    )
    if (cache) lines.push(`依赖图构建：缓存命中 ${cache.hits} 个，重新解析 ${cache.parsed} 个，用时 ${cache.ms}ms`)
  }
  if (!plan.changed.length) {
    lines.push(
      '',
      '改动清单为空：可能这些改动已经提交（或还没开始改）。带任务基线再看：`node scripts/changed-tests.mjs --since <开工时的 HEAD>`，npm 入口用 `npm run test:affected -- --since <基线>`。',
    )
  } else if (!plan.tests.length && !plan.shards.length) {
    lines.push('没有匹配到增量测试。')
  }
  if (plan.tests.length) {
    lines.push(
      '',
      `单测文件（增量，${plan.tests.length} 个${plan.full.tests.required ? '，仅供参考，命令仍为全量' : ''}）：`,
      ...plan.tests.map((t) => `  - ${t}`),
    )
  }
  if (plan.shards.length) {
    lines.push('', `界面分片（增量，${plan.shards.length} 个）：`, ...plan.shards.map((s) => `  - ${s}`))
  }

  lines.push('', '是否必须跑全量：')
  const dim = (label, full) => {
    if (!full.required) lines.push(`  - ${label}：不需要（按上面的清单跑增量，影响面已覆盖间接依赖）`)
    else for (const reason of full.reasons) lines.push(`  - ${label}：需要 — ${reason.detail}`)
  }
  dim('单测', plan.full.tests)
  dim('界面检查', plan.full.ui)
  if (plan.e2e)
    lines.push('  - e2e：需要 — 改动在高风险区（执行链路 / CLI 解析 / 内置模板 / 数据 schema），合并后由父对话跑')

  if (plan.unmapped.length) {
    lines.push(
      '',
      '映射不出来（这些改动没有对应的增量测试，跑全量或交给父对话，不要静默跳过）：',
      ...plan.unmapped.map((u) => `  - ${u.file}：${u.reason}`),
    )
  }
  if (plan.ignored.length) {
    lines.push('', `不涉及测试的改动（${plan.ignored.length} 个）：`, ...plan.ignored.map((f) => `  - ${f}`))
  }

  if (plan.direct) {
    lines.push(
      '',
      '直接映射 vs 影响面分析：',
      `  - 直接映射（同名 / 直接 import / 同目录）：${plan.direct.tests.length} 个单测文件，${plan.direct.shards.length} 个界面分片，${estText(plan.direct.tests.length)}`,
      `  - 影响面分析（含间接依赖）：${plan.tests.length} 个单测文件，${plan.shards.length} 个界面分片，${estText(plan.tests.length)}`,
    )
  }

  if (plan.commands.tests)
    lines.push('', plan.full.tests.required ? '单测命令（必须全量）：' : '单测命令：', plan.commands.tests)
  if (plan.commands.ui)
    lines.push('', plan.full.ui.required ? '界面检查命令（必须全量）：' : '界面检查命令：', plan.commands.ui)
  if (plan.changed.length && !plan.commands.tests && !plan.commands.ui)
    lines.push('', '这批改动没有对应的增量测试：交给父对话合并后跑全量。')
  return lines.join('\n')
}
