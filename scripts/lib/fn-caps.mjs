// 函数行数上限的共用部分：找出源码里超过上限的函数（见 scripts/file-caps.mjs、rules-check 第 15b 条）
//
// 为什么要有：文件行数上限管不到函数，runAgent、createRun、makeOrchestra 这些闭包一个就上千行，
// 内层函数共享外层的可变变量，哪个变量被谁改了只能从头读到尾。和文件上限一样只拦「继续变大」。
// 解析借 oxlint 的 max-lines-per-function（TypeScript 7 没有 JS API，仓库里也没有别的解析器）。
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 超过 limit 行的函数：键是 `文件#函数名`，同一文件里同名的第二个起加 `@2`，匿名函数叫 `(匿名)`。
 * 只看 server、shared、web/src 下的源码，不含测试。
 */
export function longFunctions(root, limit) {
  // oxlint 的配置按上限现写一份：只开函数行数这一条，空行和注释都算（和文件行数一个口径）
  const dir = path.join(root, '.tmp')
  mkdirSync(dir, { recursive: true })
  const config = path.join(dir, 'oxlintrc.fn-caps.json')
  const rule = ['error', { max: limit, skipBlankLines: false, skipComments: false, IIFEs: true }]
  writeFileSync(config, JSON.stringify({ plugins: [], categories: {}, rules: { 'max-lines-per-function': rule } }))
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint')
  const r = spawnSync(
    bin,
    [
      ...['-c', config, '-f', 'json', '--ignore-pattern', '**/*.test.ts', '--ignore-pattern', '**/*.test.tsx'],
      ...['server', 'shared', 'web/src'],
    ],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.error) throw r.error
  const { diagnostics } = JSON.parse(r.stdout)
  const out = []
  const seen = new Map()
  const rows = diagnostics
    .filter((d) => d.code?.includes('max-lines-per-function'))
    .map((d) => ({
      file: d.filename.replaceAll('\\', '/'),
      line: d.labels?.[0]?.span?.line ?? 0,
      name: /`([^`]+)`/.exec(d.message)?.[1] ?? '(匿名)',
      lines: Number(/\((\d+)\)/.exec(d.message)?.[1] ?? 0),
    }))
    .filter((x) => !x.file.startsWith('shared/locales/'))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  for (const x of rows) {
    const base = `${x.file}#${x.name}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    out.push({ ...x, key: n > 1 ? `${base}@${n}` : base })
  }
  return out
}
