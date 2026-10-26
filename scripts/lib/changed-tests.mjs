/**
 * 改动 → 要跑的测试：子对话按这里只跑命中的单测文件和界面检查分片，全量交给父对话合并后跑。
 *
 * 这里是纯逻辑（不碰文件系统、不跑命令）：CLI 用 scripts/changed-tests.mjs 收集文件清单和读源码，
 * 单测用固定的小文件树钉住定位规则。定位有四种依据，从准到宽：
 * 1. 同名测试：`shared/foo.ts` → `shared/foo.test.ts`（TS 和 mjs 都认）
 * 2. 反向 import：哪个测试文件 import 了它（`@shared/`、`@/`、相对路径都解析）
 * 3. 同目录测试：还没有命中的话，同目录下的测试都跑（回退，宁可多跑几个文件也不漏）
 * 4. 界面检查分片：按 scripts/ui/covers.mjs 的前缀表定位（改一个组件只跑它所在的分片）
 *
 * 映射不出来时**明确列出来**（`unmapped`），由调用方提示「跑全量或交给父对话」，不静默跳过。
 */
import path from 'node:path'

/** 测试文件：`.test.ts` / `.test.tsx` / `.test.mjs` / `.spec.ts` 这类 */
export const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/
/** 需要测试的代码文件：TS / JS / mjs / cjs（文档、图片、配置不算） */
export const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/
const STRIP_EXT = /\.(?:[cm]?[jt]sx?)$/

/**
 * 同目录回退的上限：一个目录里的测试多到这个数，说明它是公共目录（web/src/lib、shared/ 根下），
 * 跑它全部已经等于跑大半个模块，不该再冒充「增量」。超过就报「映射不出来」，由调用方跑全量或交给父对话。
 */
export const SAME_DIR_FALLBACK_MAX = 6
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * 比对一个模块时用的键：去掉扩展名和末尾的 /index。
 * `shared/foo.ts`、`shared/foo`、`shared/foo/index.ts` 都会被解析到同一个键
 */
export function moduleKey(rel) {
  return norm(rel)
    .replace(STRIP_EXT, '')
    .replace(/\/index$/, '')
}

/**
 * 把测试文件里 import 的写法解析成相对项目根的路径：
 * - `@shared/x` → `shared/x`（tsconfig 的别名）
 * - `@/x` → `web/src/x`
 * - `./x` / `../x` → 相对当前文件
 * - 包名（node:xxx、react 这类）返回空字符串
 */
export function resolveSpec(spec, fromFile) {
  const s = String(spec)
  if (s.startsWith('@shared/')) return norm('shared/' + s.slice('@shared/'.length))
  if (s.startsWith('@/')) return norm('web/src/' + s.slice(2))
  if (!s.startsWith('.')) return ''
  return norm(path.posix.normalize(path.posix.join(path.posix.dirname(norm(fromFile)), s)))
}

/**
 * 源码里 import / require 了哪些模块（相对写法原样返回，交给 resolveSpec 解析）。
 * 只认静态 import、动态 import() 和 require；不跑完整的 parser，测试文件都很简单
 */
export function importsOf(code) {
  const out = new Set()
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  for (const m of String(code).matchAll(re)) out.add(m[1])
  return [...out]
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
  file === 'scripts/ui-check.mjs' || file === 'scripts/ui/harness.mjs' || file === 'scripts/ui/covers.mjs'

/**
 * 定位器。`readFile` 不传时跳过反向 import 那一步（只做同名 / 同目录 / 分片），
 * 单测可以不准备文件内容。
 */
export function planChangedTests({ changed, testFiles, covers = {}, readFile }) {
  const files = [...new Set((changed ?? []).map(norm))].filter(Boolean)
  const tests = new Set()
  const shardHits = new Set()
  const unmapped = []
  const ignored = []
  const testSet = new Set((testFiles ?? []).map(norm))
  const sortedTests = [...testSet].sort()
  /** 读过的测试文件内容缓存：一个测试文件只读一次 */
  const content = new Map()
  const code = (t) => {
    if (!readFile) return ''
    if (!content.has(t)) content.set(t, String(readFile(t) ?? ''))
    return content.get(t)
  }

  for (const file of files) {
    // 界面检查自己的脚本：改哪个分片跑哪个；改公共部分跑全部分片
    if (isUiRunner(file)) {
      for (const shard of Object.keys(covers)) shardHits.add(shard)
      continue
    }
    if (file.startsWith('scripts/ui/') && file.endsWith('.mjs')) {
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
    if (!CODE_FILE.test(file)) {
      ignored.push(file)
      continue
    }

    const hit = new Set()
    // 1) 同名测试
    const base = file.replace(STRIP_EXT, '')
    for (const suffix of ['.test.ts', '.test.tsx', '.test.mjs', '.spec.ts', '.spec.mjs'])
      if (testSet.has(base + suffix)) hit.add(base + suffix)
    // 2) 反向 import：测试里 import 了这个模块（别名和相对路径都解析）
    if (!hit.size && readFile) {
      const key = moduleKey(file)
      for (const t of sortedTests)
        if (importsOf(code(t)).some((spec) => moduleKey(resolveSpec(spec, t)) === key)) hit.add(t)
    }
    // 3) 同目录测试：还没命中才回退，且目录里的测试不多时才回退——
    // 公共目录（web/src/lib、shared/ 根下）几十个测试全跑就是全量，交给父对话更诚实
    if (!hit.size) {
      const dir = path.posix.dirname(file)
      const sameDir = sortedTests.filter((t) => path.posix.dirname(t) === dir)
      if (sameDir.length && sameDir.length <= SAME_DIR_FALLBACK_MAX) sameDir.forEach((t) => hit.add(t))
    }
    hit.forEach((t) => tests.add(t))

    const shards = shardsFor(file, covers)
    shards.forEach((s) => shardHits.add(s))

    // 界面改动按分片判断：命中单测不等于界面也被覆盖了（通用组件常常有单测但没有分片映射）
    if (file.startsWith('web/src/') && !shards.length) {
      unmapped.push({
        file,
        reason: '没有对应的界面检查分片（通用组件、演示数据这类会影响所有页面），跑全量的界面检查',
      })
    } else if (!hit.size && !shards.length) {
      unmapped.push({
        file,
        reason: '没有找到对应的单测文件（同名 / 反向 import 没有命中，同目录测试太多或没有），跑全量单测或交给父对话',
      })
    }
  }

  const testList = [...tests].sort()
  const shardList = [...shardHits].sort()
  return {
    changed: files,
    tests: testList,
    shards: shardList,
    unmapped,
    ignored,
    commands: {
      tests: testList.length ? `npx tsx --test ${testList.join(' ')}` : '',
      // 界面检查的产物必须是这次源码构建出来的（ui-check 会校验），所以先构建再按分片跑
      ui: shardList.length
        ? `npx vite build --mode demo && node scripts/ui-check.mjs ${shardList.map((s) => s.replace(/\.mjs$/, '')).join(' ')}`
        : '',
    },
  }
}

/** 给人看的输出：先说结论（跑哪几条），再列映射不出来的改动，最后是可直接执行的命令 */
export function reportChangedTests(plan) {
  const lines = []
  lines.push(`改动 ${plan.changed.length} 个文件`)
  if (!plan.tests.length && !plan.shards.length) lines.push('没有匹配到增量测试。')
  if (plan.tests.length) {
    lines.push('', `单测文件（${plan.tests.length} 个）：`, ...plan.tests.map((t) => `  - ${t}`))
  }
  if (plan.shards.length) {
    lines.push('', `界面检查分片（${plan.shards.length} 个）：`, ...plan.shards.map((s) => `  - ${s}`))
  }
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
  if (plan.commands.tests) lines.push('', '单测命令：', plan.commands.tests)
  if (plan.commands.ui) lines.push('', '界面检查命令：', plan.commands.ui)
  if (!plan.commands.tests && !plan.commands.ui) lines.push('', '这批改动没有对应的增量测试：交给父对话合并后跑全量。')
  return lines.join('\n')
}
