// 大文件行数上限的共用部分：哪些文件算源码、上限怎么取整（见 scripts/file-caps.mjs）
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const capsPath = (root) => path.join(root, 'scripts', 'file-caps.json')

/** 受管的源码：前后端和共享层的 ts / tsx，不含测试、英文词典 */
export function sourceFiles(root) {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'server', 'shared', 'web/src'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('shared/locales/'))
}

export const linesOf = (root, file) => readFileSync(path.join(root, file), 'utf8').split('\n').length

/** 上限：当前行数留 50 行余量，取整到 50（小修小补不用每次改上限） */
export const capOf = (lines) => Math.ceil((lines + 50) / 50) * 50
