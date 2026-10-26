/**
 * 源码的 import 依赖图与反向闭包：改动一个被几十处 import 的模块时，光看「同名测试 + 直接 import」
 * 只能覆盖一小部分，真正可能被影响的是所有**间接**依赖它的文件和它们的测试。
 *
 * 这里只做纯逻辑（不碰文件系统、不跑命令）：解析 import、解析别名和扩展名、建正反向边、从改动文件
 * 出发求反向闭包。文件和缓存由 CLI（scripts/changed-tests.mjs）提供，单测用固定的小文件树钉住规则。
 */
import path from 'node:path'

/** 可能是源码的文件：TS / JS / mjs / cjs */
export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
/** 测试文件：`.test.ts` / `.test.tsx` / `.test.mjs` / `.spec.ts` 这类 */
export const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/
const STRIP_EXT = /\.(?:[cm]?[jt]sx?)$/

/** 解析 spec 时按顺序试的后缀：TS 项目里 import 常常不写扩展名，也可能直接写 .ts / .js */
const EXT_CANDIDATES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
/** 目录 import 解析到它的 index 文件 */
const INDEX_CANDIDATES = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs']

export const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '')

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
 * 把 import 的写法解析成相对项目根的路径：
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
 * 源码里 import / require 了哪些模块。除了写死的字符串，还标出「有解析不了的写法」
 * （动态 import 变量、require 变量）：那种情况下我们说不出它依赖谁，只能让调用方保守处理。
 *
 * 语句级的 import 要求从行首开始：演示数据和提示词里常有一整段示例代码（`"import X from './pages/Home'"`），
 * 那些示例里的 import 不是真依赖，按行首判断能挡住它们，又不用引入完整的 parser。
 */
export function parseImports(code) {
  const text = String(code)
  const specs = new Set()
  const patterns = [
    // import … from '…' / import '…'：import 后到 from 之间不含引号和分号（项目不用分号，
    // 不能用 [^;] 跨语句，否则一条 export const 会一路吞到后面某个 from）
    /^\s*import\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    // export … from '…'：只认 re-export，`export const` / `export function` 不是
    /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm,
    // import('…') / require('…')：出现在表达式中间，但前面是引号时是字符串里的示例
    /(?:^|[^\w$.'"`])(?:import|require)\s*\(\s*['"]([^'"]+)['"]/gm,
  ]
  for (const re of patterns) for (const m of text.matchAll(re)) specs.add(m[1])
  // 非字面量的动态 import / require：`import(name)`、`import(`…`)`、`require(expr)`。
  // 只认真代码位置（行首、赋值 / 参数 / await 后），注释里举例的 `require(expr)` 不算
  const opaque = /(?:^\s*|[=,([]\s*|\bawait\s+)(?:import|require)\s*\(\s*[^'"\s)]/m.test(text)
  return { specs: [...specs], opaque }
}

/** 旧接口：只要 spec 列表（changed-tests 与它的单测都还在用） */
export function importsOf(code) {
  return parseImports(code).specs
}

/** 解析出来的路径能不能落在已知文件上；试扩展名和 /index */
function matchFile(rel, fileSet) {
  if (fileSet.has(rel)) return rel
  for (const ext of EXT_CANDIDATES.slice(1)) if (fileSet.has(rel + ext)) return rel + ext
  for (const ext of INDEX_CANDIDATES) if (fileSet.has(rel + ext)) return rel + ext
  return ''
}

/**
 * 一条 spec 落到的仓库文件：外部包和非源码（css、图片）返回空，解析不到源码时进 unresolved。
 * `fileSet` 是这次扫描到的所有文件，只有它们之间的边才参与闭包。
 */
export function resolveImport(spec, fromFile, fileSet) {
  const rel = resolveSpec(spec, fromFile)
  if (!rel) return { kind: 'external' }
  const hit = matchFile(rel, fileSet)
  if (hit) return { kind: 'file', file: hit }
  // 显式写了别的扩展名（css、图片、json）不是依赖图的节点；没有扩展名又找不到源码才是算不出来
  return /\.[a-z0-9]+$/i.test(rel) && !SOURCE_FILE.test(rel) ? { kind: 'external' } : { kind: 'unresolved', spec: rel }
}

/**
 * 建依赖图。
 * `load(file)` 返回 `{ specs, opaque }`（CLI 从缓存里给，单测直接给固定内容）。
 * 返回正向边（文件 → 它依赖的文件）、反向边（文件 → 依赖它的文件）和两处「算不出来」的记录。
 */
export function buildImportGraph({ files, load }) {
  const fileSet = new Set((files ?? []).map(norm))
  const edges = new Map()
  const reverse = new Map()
  const unresolved = []
  const opaque = []
  for (const file of fileSet) {
    const parsed = load(file) ?? { specs: [], opaque: false }
    const deps = new Set()
    for (const spec of parsed.specs ?? []) {
      const r = resolveImport(spec, file, fileSet)
      if (r.kind === 'file') deps.add(r.file)
      else if (r.kind === 'unresolved') unresolved.push({ from: file, spec: r.spec })
    }
    // 有非字面量的 import：这个文件可能还依赖图里任何一个文件
    if (parsed.opaque) opaque.push({ from: file })
    edges.set(file, [...deps])
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set())
      reverse.get(dep).add(file)
    }
  }
  return { files: fileSet, edges, reverse, unresolved, opaque }
}

/**
 * 从改动文件出发求反向依赖闭包：所有（直接或间接）依赖它们的文件 + 它们自己。
 * 不在图里的改动照样留在结果里（新文件、图外目录），由调用方按「映射不出来」处理。
 */
export function reverseClosure({ reverse, changed }) {
  const seen = new Set()
  const queue = []
  for (const file of changed ?? []) {
    const f = norm(file)
    if (!seen.has(f)) {
      seen.add(f)
      queue.push(f)
    }
  }
  while (queue.length) {
    const current = queue.shift()
    for (const dependent of reverse.get(current) ?? []) {
      if (seen.has(dependent)) continue
      seen.add(dependent)
      queue.push(dependent)
    }
  }
  return seen
}

/** 一个文件（直接或间接）依赖了哪些文件，含自己。给「测试覆盖了哪些源码」这种正向判断用 */
export function forwardClosure({ edges, file }) {
  const seen = new Set()
  const queue = [norm(file)]
  while (queue.length) {
    const current = queue.shift()
    if (seen.has(current)) continue
    seen.add(current)
    for (const dep of edges.get(current) ?? []) if (!seen.has(dep)) queue.push(dep)
  }
  return seen
}
