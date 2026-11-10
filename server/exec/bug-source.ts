/**
 * Bug 诊断报告交上来时取原文（shared/bug-quotes.ts 的 BugSource）：读项目文件、取引入改动的 diff、
 * 交验证时取每个改了的文件和对话开始时比的 diff（「修复」那一步显示，shared/bug-fix.ts）。
 * 交报告是工具调用，宿主同步回答：文件只读前 5 MB，git 命令限时 5 秒，取不到就返回 undefined（报告照常交，只是没有原文）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BugSource } from '../../shared/bug-quotes.ts'
import type { Project, Task } from '../../shared/schema.ts'

const MAX = 5_000_000

/** 这个对话改文件的目录：独立分支在用就是它的工作区，否则是项目目录 */
export const workDirOf = (task: Pick<Task, 'worktree'>, project: Pick<Project, 'path'>) =>
  task.worktree?.state === 'active' ? task.worktree.path : project.path

/** 同步跑一条 git，退出码不为 0 也要输出（diff --no-index 有差异时返回 1）；跑不起来返回 undefined */
function gitSync(dir: string, args: string[]) {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4 << 20,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return r.error ? undefined : { code: r.status ?? 1, out: r.stdout ?? '' }
}

/** baseRef：对话开始时的提交（Task.baseRef），没有或找不到时和 HEAD 比 */
export function bugSource(dir: string, baseRef = ''): BugSource | undefined {
  if (!dir) return undefined
  let base: string | undefined
  const baseOf = () =>
    (base ??=
      baseRef && gitSync(dir, ['cat-file', '-e', `${baseRef}^{commit}`])?.code === 0
        ? baseRef
        : gitSync(dir, ['rev-parse', '--verify', 'HEAD'])?.code === 0
          ? 'HEAD'
          : '')
  return {
    diff(file) {
      const b = baseOf()
      let out = b ? gitSync(dir, ['diff', '--no-color', b, '--', file])?.out : ''
      if (out === undefined) return undefined
      if (!out.trim() && gitSync(dir, ['ls-files', '--error-unmatch', '--', file])?.code !== 0)
        // 没跟踪的新文件：和空文件比
        out = gitSync(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', file])?.out ?? ''
      return out
    },
    read(file) {
      try {
        const p = path.resolve(dir, file)
        if (statSync(p).size > MAX) return undefined
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    commit(rev) {
      // 提交号是 Agent 写的：先确认它确实是一个提交（写成选项、路径的在这里就不成立），再取作者
      if (gitSync(dir, ['cat-file', '-e', `${rev}^{commit}`])?.code !== 0) return undefined
      const out = gitSync(dir, ['show', '-s', '--date=short', '--format=%an%x00%ad%x00%s', rev])
      if (!out || out.code !== 0) return undefined
      const [author = '', date = '', title = ''] = out.out.trim().split('\0')
      return author ? { author, date, title } : undefined
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
