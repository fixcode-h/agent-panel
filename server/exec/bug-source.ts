/**
 * Bug 诊断报告交上来时取原文（shared/bug/quotes.ts 的 BugSource）：读项目文件、取引入改动的 diff、
 * 交验证时取每个改了的文件和对话开始时比的 diff（「修复」那一步显示，shared/bug/fix.ts）。
 * 交报告是工具调用，宿主同步回答：文件只读前 5 MB，git 命令限时 5 秒，取不到就返回 undefined（报告照常交，只是没有原文）
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BugSource } from '../../shared/bug/quotes.ts'
import type { Project, Task } from '../../shared/schema.ts'
import { gitSync as runGit } from './git.ts'

const MAX = 5_000_000
/** 按行号取日志文件的那几行时最多读这么大（UE 的日志动辄上百 MB）；交报告是同步工具调用，再大就不读了 */
const MAX_LOG = 512_000_000

/** 文件的第 start~end 行：按字节找换行，只解码要的那几行，不把整个大文件转成字符串 */
function readLines(p: string, start: number, end: number) {
  if (statSync(p).size > MAX_LOG) return undefined
  const buf = readFileSync(p)
  let line = 1
  let from = start === 1 ? 0 : -1
  let to = buf.length
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) {
    line++
    if (line === start) from = i + 1
    if (line === end + 1 && to === buf.length) to = i
  }
  // 末尾的换行不算多出一行
  const total = buf.length && buf[buf.length - 1] === 10 ? line - 1 : line
  const text = from < 0 ? '' : buf.subarray(from, to).toString('utf8').replace(/\r\n?/g, '\n').replace(/\n$/, '')
  return { text, total }
}

/** 这个对话改文件的目录：独立分支在用就是它的工作区，否则是项目目录 */
export const workDirOf = (task: Pick<Task, 'worktree'>, project: Pick<Project, 'path'>) =>
  task.worktree?.state === 'active' ? task.worktree.path : project.path

/** 同步跑一条 git，退出码不为 0 也要输出（diff --no-index 有差异时返回 1）；跑不起来返回 undefined */
const gitSync = (dir: string, args: string[]) => runGit(dir, args, { timeoutMs: 5000 })

/**
 * baseRef：对话开始时的提交（Task.baseRef），没有或找不到时和 HEAD 比；
 * env：采集环境（server/exec/bug-env.ts），交第一份报告时才调
 */
export function bugSource(dir: string, baseRef = '', env?: BugSource['env']): BugSource | undefined {
  if (!dir) return undefined
  let base: string | undefined
  let inRepo: boolean | undefined
  // 不是 git 工作区（P4、SVN 的工程）：没有对话开始时的版本可比，diff 返回 undefined，
  // 由调用方改用 Agent 改文件时记下的改动（shared/bug/fix.ts 的 editPatch）。
  // 不能退回「和空文件比」：那样整个文件都画成新增（用户 2026-11-11 报）
  const repo = () => (inRepo ??= gitSync(dir, ['rev-parse', '--is-inside-work-tree'])?.out.trim() === 'true')
  const baseOf = () =>
    (base ??=
      baseRef && gitSync(dir, ['cat-file', '-e', `${baseRef}^{commit}`])?.code === 0
        ? baseRef
        : gitSync(dir, ['rev-parse', '--verify', 'HEAD'])?.code === 0
          ? 'HEAD'
          : '')
  return {
    env,
    diff(file) {
      if (!repo()) return undefined
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
    lines(file, start, end) {
      try {
        return readLines(path.resolve(dir, file), start, end)
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
      const r = runGit(dir, ['show', '--format=', '--no-color', rev, '--', file], {
        timeoutMs: 5000,
        maxBuffer: 1 << 20,
      })
      return r?.code === 0 ? r.out : undefined
    },
  }
}
