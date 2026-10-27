/**
 * 单测文件在哪：scripts/unit-tests.mjs 跑它们，scripts/test-budget.mjs 数它们，两边同一个口径。
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'

/** 测试文件分布在这几棵目录下；每棵目录只收自己那种后缀（旧 glob：scripts 是 `.test.mjs`，其余是 `.test.ts`） */
export const TEST_ROOTS = [
  ['server', /\.test\.ts$/],
  ['shared', /\.test\.ts$/],
  ['web/src', /\.test\.ts$/],
  ['scripts', /\.test\.mjs$/],
]

/** 依赖和生成物里没有源码测试，递归时整棵剪掉，免得把装出来的东西当成用例 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-demo',
  'release',
  'ui-shots',
  'attachments',
  'coverage',
  '.git',
])

/** 一棵目录下的测试文件，返回相对 root、用 / 分隔的路径 */
export function listTests(root, dir, suffix) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (suffix.test(entry.name)) {
        out.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(root, dir))
  return out
}

/** 全部单测文件（按原先 test:unit 的口径），排好序 */
export const listUnitTests = (root) => TEST_ROOTS.flatMap(([dir, suffix]) => listTests(root, dir, suffix)).sort()
