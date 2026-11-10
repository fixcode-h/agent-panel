/**
 * Bug 诊断报告交上来时取原文（shared/bug-quotes.ts 的 BugSource）：读项目文件、取引入改动的 diff。
 * 交报告是工具调用，宿主同步回答：文件只读前 5 MB，git 命令限时 5 秒，取不到就返回 undefined（报告照常交，只是没有原文）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BugSource } from '../../shared/bug-quotes.ts'
import type { Project, Task } from '../../shared/schema.ts'

const MAX = 5_000_000

/** 这个对话改文件的目录：独立分支在用就是它的工作区，否则是项目目录 */
export const workDirOf = (task: Pick<Task, 'worktree'>, project: Pick<Project, 'path'>) =>
  task.worktree?.state === 'active' ? task.worktree.path : project.path

export function bugSource(dir: string): BugSource | undefined {
  if (!dir) return undefined
  return {
    read(file) {
      try {
        const p = path.resolve(dir, file)
        if (statSync(p).size > MAX) return undefined
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    show(rev, file) {
      try {
        return execFileSync('git', ['-C', dir, 'show', '--format=', '--no-color', rev, '--', file], {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 1 << 20,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        return undefined
      }
    },
  }
}
