/**
 * 在线演示版（dist-demo）的构建标记。
 *
 * 界面检查跑的是 `npx vite build --mode demo` 的产物：源码改了却没重新构建时，它会拿旧产物跑出
 * 「通过」或者大面积「找不到元素」，白花时间还误导人。所以构建结束时（vite.config.ts）把参与构建的
 * 每个源文件的短哈希写进 dist-demo/.build-info.json，ui-check 启动时重算一遍，对不上就明确失败。
 *
 * 用内容哈希而不是 mtime：切分支、git checkout 会改 mtime 但内容没变，那种不算过期。
 * 校验失败时选「直接失败」而不是自动重建：构建要几十秒，而且构建本身的错误（类型错误、缺依赖）
 * 该被单独看到，不该藏在界面检查里。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 构建标记文件名，放在产物目录里（.gitignore 已覆盖 dist-demo） */
export const BUILD_INFO_FILE = '.build-info.json'

// 参与构建的源文件：前端源码、前后端共用的 shared、公共资源，以及入口 HTML、构建配置和依赖锁（锁变了产物也可能变）
const SOURCE_DIRS = ['web/src', 'shared', 'web/public']
const SOURCE_FILES = ['web/index.html', 'vite.config.ts', 'package.json', 'package-lock.json']
// 测试文件不进产物，改了不需要重新构建
const TEST_FILE = /\.test\.tsx?$/
// 提示里最多列这么多个变了的文件，剩下的只报数量
const MAX_LISTED = 10

const short = (data) => createHash('sha1').update(data).digest('hex').slice(0, 12)
const posix = (p) => p.split(path.sep).join('/')

/** 参与构建的源文件，相对仓库根、正斜杠，按路径排序 */
export function demoSources(root) {
  const files = SOURCE_FILES.filter((f) => existsSync(path.join(root, f)))
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      // 隐藏文件（.DS_Store）、编辑器临时文件（*.swp）不进产物，也不能因为它们的增删就要求重建
      else if (!e.name.startsWith('.') && !TEST_FILE.test(e.name) && !/\.(swp|swo|orig|bak|tmp)$/.test(e.name))
        files.push(posix(path.relative(root, p)))
    }
  }
  for (const d of SOURCE_DIRS) if (existsSync(path.join(root, d))) walk(path.join(root, d))
  return files.sort()
}

/**
 * 源文件当前的指纹：hash 是全量的总指纹，files 是每个文件的短哈希（用来指出具体哪个文件变了）。
 * 总指纹算「路径:哈希」拼起来再哈希，所以增删文件同样会变。
 */
export function demoSourceInfo(root) {
  const files = {}
  for (const f of demoSources(root)) files[f] = short(readFileSync(path.join(root, f)))
  const hash = short(
    Object.entries(files)
      .map(([f, h]) => `${f}:${h}`)
      .join('\n'),
  )
  return { hash, files }
}

/** 构建结束时调用（vite.config.ts 的 demo 构建）：把这次构建用的源文件指纹写进产物目录 */
export function writeDemoBuildInfo(root, outDir) {
  const info = { ...demoSourceInfo(root), at: new Date().toISOString() }
  writeFileSync(path.join(outDir, BUILD_INFO_FILE), JSON.stringify(info, null, 2) + '\n')
}

/**
 * 产物和源码对不对得上。
 * reason：missing-dist（没构建过）、missing-info / bad-info（产物是旧版本或别的构建留下的）、stale（源码改过没重建）。
 */
export function checkDemoBuild(root, outDir) {
  if (!existsSync(path.join(outDir, 'index.html'))) return { ok: false, reason: 'missing-dist', changed: [] }
  const infoFile = path.join(outDir, BUILD_INFO_FILE)
  if (!existsSync(infoFile)) return { ok: false, reason: 'missing-info', changed: [] }
  let saved
  try {
    saved = JSON.parse(readFileSync(infoFile, 'utf8'))
  } catch {
    return { ok: false, reason: 'bad-info', changed: [] }
  }
  const now = demoSourceInfo(root)
  if (saved?.hash === now.hash) return { ok: true, reason: '', changed: [] }
  const changed = []
  const before = saved?.files ?? {}
  for (const f of [...new Set([...Object.keys(before), ...Object.keys(now.files)])].sort()) {
    if (before[f] === now.files[f]) continue
    changed.push(before[f] === undefined ? `新增 ${f}` : now.files[f] === undefined ? `删除 ${f}` : `改动 ${f}`)
  }
  return { ok: false, reason: 'stale', changed }
}

/** 产物不可用时给用户看的提示；一切正常返回 null（便于单测直接断言提示内容） */
export function describeDemoBuildProblem(root, outDir = path.join(root, 'dist-demo')) {
  const r = checkDemoBuild(root, outDir)
  if (r.ok) return null
  const rebuild = '先运行 npx vite build --mode demo 再跑界面检查'
  if (r.reason === 'missing-dist') return `没有演示版产物（dist-demo/index.html）：${rebuild}`
  if (r.reason === 'missing-info' || r.reason === 'bad-info')
    return `dist-demo 里没有可用的构建标记（${BUILD_INFO_FILE}），产物来源不明：${rebuild}`
  const lines = r.changed.slice(0, MAX_LISTED).map((c) => `  ${c}`)
  if (r.changed.length > MAX_LISTED) lines.push(`  ……共 ${r.changed.length} 个文件`)
  return ['dist-demo 是旧产物：源码改过之后还没有重新构建，界面检查会拿旧页面跑出假结果。', ...lines, rebuild].join(
    '\n',
  )
}

/** 两个入口（scripts/ui-check.mjs、scripts/ui/harness.mjs）启动时调用：产物不可用就打印原因并退出 */
export function assertDemoBuildFresh(root) {
  const problem = describeDemoBuildProblem(root)
  if (!problem) return
  console.error(problem)
  process.exit(1)
}
