/**
 * 测试分层：判定一个测试文件属于纯函数层还是集成层，e2e 分片单独一层。
 *
 * 为什么按运行时特征而不是按目录：现有测试和源文件同目录，按目录分层会和模块目录打架；
 * 一个文件要不要起服务、建临时目录、跑 git、开子进程，看它源码里的调用就知道，改名迁移也只是改文件名。
 *
 * 判据只在下面这张表里写一次：新增一类运行时特征就加一行，报告、预算、测试都读它。
 * 层名同时也是「用例预算」的键（见 scripts/lib/test-budget.mjs），两边不要各写一套字符串。
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'

/** 层名：纯函数层只做内存里的计算；集成层碰真实环境；e2e 层是 scripts/e2e/ 下的分片 */
export const LAYERS = { pure: 'pure', integration: 'integration', e2e: 'e2e' }

/**
 * e2e 分片的文件名：必须和 scripts/e2e.mjs 收集分片的正则一致（`/^\d+-.*\.mjs$/`），
 * 否则报告里的「e2e 分片数」和实际会跑的分片对不上。harness、辅助脚本和它们自己的单测不匹配。
 */
export const E2E_SHARD_FILE = /^\d+-.*\.mjs$/

const E2E_SHARD_DIR = 'scripts/e2e/'

/**
 * 集成层的运行时特征。任何一条命中即归集成层（spec: Test layer classification）。
 * 正则按「调用点」匹配，不按 import 匹配：`import { execFileSync }` 但没用也会被误判；
 * 裸 `exec(` 故意不收，`re.exec(str)` 在纯逻辑测试里很常见（见 server/p4-split.test.ts）。
 * 例外是 `real-files`：`node:fs/promises` 的 import 也算——异步 API 的名字太泛（`rm` / `open`），
 * 按调用点收会把业务 helper（`open()`、`link()`）误判成文件读写。
 */
export const INTEGRATION_MARKERS = [
  {
    id: 'http-server',
    label: '启动 HTTP 服务 / 监听端口',
    test: /\b(?:Hono|createServer)\b|\.listen\s*\(/,
  },
  {
    id: 'temp-dir',
    label: '建临时目录',
    test: /\bmkdtemp(?:Sync)?\s*\(/,
  },
  {
    id: 'real-files',
    label: '读写真实文件',
    // 同名 API 的同步 / 异步两种形态都算：`fs.promises` 的 readFile / rm 这类不带 Sync 后缀，
    // 漏掉会把真读写临时文件的用例算进纯函数层（server/exec/system-prompt.test.ts 就是这样漏的）。
    // 只收不会和本地 helper 撞名的名字：`open(` / `link(` / `stat(` 这类短名在测试里常是业务函数（如 design-mcp.test.ts 的 open）。
    test: /\b(?:readFile|writeFile|readdir|copyFile|appendFile|mkdir|rename|truncate|rmSync|openSync|createWriteStream|createReadStream)(?:Sync)?\s*\(|from\s+['"](?:node:)?fs\/promises['"]/,
  },
  {
    id: 'git',
    label: '执行 git 命令',
    // 只认「用子进程 API 直接跑 git」：单独的 `'git'` 字样（例如断言里列特征标签）不是执行
    test: /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*[`'"]git\b/,
  },
  {
    id: 'child-process',
    label: '开子进程 / 连接真实 CLI',
    test: /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/,
  },
]

/** 命中哪些集成特征：返回特征 id 列表，顺序跟表格一致（报告里按这个顺序打印） */
export function integrationMarkers(sourceText) {
  return INTEGRATION_MARKERS.filter((m) => m.test.test(sourceText)).map((m) => m.id)
}

/** 是不是被 e2e 总入口调度的分片（只看路径和文件名，不看文件内容） */
export function isE2eShard(file) {
  const rel = String(file).replace(/\\/g, '/')
  return rel.startsWith(E2E_SHARD_DIR) && E2E_SHARD_FILE.test(rel.slice(E2E_SHARD_DIR.length))
}

/**
 * 判定一个测试文件的层。e2e 分片只按目录归属；其余文件看运行时特征。
 * 返回 { layer, markers }：markers 是命中的集成特征 id，纯函数层和 e2e 层为空数组。
 */
export function layerOf(file, sourceText) {
  if (isE2eShard(file)) return { layer: LAYERS.e2e, markers: [] }
  const markers = integrationMarkers(sourceText ?? '')
  return { layer: markers.length ? LAYERS.integration : LAYERS.pure, markers }
}

/**
 * 单测文件的枚举口径：每棵目录只收自己那种后缀（scripts 下是 .test.mjs，其余是 .test.ts）。
 * 和 scripts/unit-tests.mjs 的 TEST_ROOTS / SKIP_DIRS 是同一份口径——那份现在还不能动（改名迁移要一起改），
 * 所以暂时两处各有一份；迁移批 1 把那边改成引用这里之后只留这一处。
 */
export const TEST_ROOTS = [
  ['server', /\.test\.ts$/],
  ['shared', /\.test\.ts$/],
  ['web/src', /\.test\.ts$/],
  ['scripts', /\.test\.mjs$/],
]

/** 依赖和生成物里没有源码测试，递归时整棵剪掉 */
export const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-demo',
  'release',
  'ui-shots',
  'attachments',
  'coverage',
  '.git',
])

const relPath = (root, file) => path.relative(root, file).split(path.sep).join('/')

/** 枚举单测文件，返回相对 root、用 / 分隔、按字典序排列的路径 */
export function listUnitTestFiles(root) {
  const out = []
  const walk = (dir, suffix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, suffix)
      } else if (suffix.test(entry.name)) {
        out.push(relPath(root, full))
      }
    }
  }
  for (const [dir, suffix] of TEST_ROOTS) walk(path.join(root, dir), suffix)
  return out.sort()
}

/** 枚举 e2e 分片（只认文件名，和 scripts/e2e.mjs 的收集口径一致） */
export function listE2eShards(root) {
  const dir = path.join(root, E2E_SHARD_DIR)
  return readdirSync(dir)
    .filter((name) => E2E_SHARD_FILE.test(name))
    .map((name) => `${E2E_SHARD_DIR}${name}`)
    .sort()
}

/**
 * 静态统计用例数：只数行首的 `test(` / `it(` 调用，不执行测试。
 * 与 tap 的 `# tests` 实测一致（2026-10-27 全量：静态 2220、tap 2220，差 0）；
 * 写法一变（例如在循环里生成用例）两边就会分叉，所以 CI 跑完单测后用 tap 复核一次。
 * 报告、预算检查、只读复核必须用同一份实现，不要各写一条正则。
 */
export function countCases(sourceText) {
  return (sourceText.match(/^\s*(?:test|it)\s*\(/gm) ?? []).length
}

/** 静态统计 e2e 分片里的步骤数（harness 提供的 `step('…')`），不跑 e2e */
export function countSteps(sourceText) {
  return (sourceText.match(/^\s*(?:await\s+)?step\s*\(/gm) ?? []).length
}

/** 读文件按 LF 切开后的行数 */
export function countLines(sourceText) {
  return sourceText.split('\n').length
}
