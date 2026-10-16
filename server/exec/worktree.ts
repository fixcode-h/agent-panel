import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { TaskWorktree } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'
import { DATA_DIR } from '../store.ts'
import { capture } from './process.ts'

/** 任务的独立工作目录放在数据目录里，不放进项目目录，免得被项目自己的 git 和工具扫到 */
export const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees')

const git = (cwd: string, ...args: string[]) =>
  capture('git', ['-c', 'core.quotepath=off', ...args], cwd, process.env, 60_000)
const fail = (r: { stderr: string; stdout: string }, fallback: string) =>
  new Error((r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n') || fallback)

/** 分支名里只留字母数字，中文标题就只用任务 id */
const branchName = (taskId: string, title: string) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return `agent-panel/${slug ? `${slug}-` : ''}${taskId.slice(0, 8)}`
}

/**
 * 给任务建一个独立的 git 工作目录（git worktree）和分支，从项目当前的提交出发。
 * Agent 在里面改，不影响项目目录，也不和同时执行的其他任务互相干扰；做完后再合并或丢弃。
 */
export async function createWorktree(repo: string, taskId: string, title: string): Promise<TaskWorktree> {
  const inside = await git(repo, 'rev-parse', '--is-inside-work-tree')
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new Error(t('项目不是 git 仓库，不能用独立分支执行'))
  const head = await git(repo, 'rev-parse', '--verify', 'HEAD')
  if (head.code !== 0) throw new Error(t('项目还没有任何提交，不能用独立分支执行'))
  const baseBranch = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  const dir = path.join(WORKTREES_DIR, taskId)
  await mkdir(WORKTREES_DIR, { recursive: true })
  const branch = branchName(taskId, title)
  const r = await git(repo, 'worktree', 'add', '-b', branch, dir, 'HEAD')
  if (r.code !== 0) throw fail(r, t('创建独立分支失败'))
  return { path: dir, branch, baseBranch: baseBranch === 'HEAD' ? '' : baseBranch, state: 'active', note: '' }
}

/** 没配置 git 用户时用面板的身份提交，免得提交失败 */
async function identity(cwd: string) {
  const email = (await git(cwd, 'config', 'user.email')).stdout.trim()
  return email ? [] : ['-c', 'user.name=Agent Panel', '-c', 'user.email=agent-panel@localhost']
}

/**
 * 合并：先把独立目录里还没提交的改动提交到任务分支，再合并进项目当前所在的分支。
 * 有冲突时放弃这次合并，项目目录保持原样，返回冲突的说明。成功后删掉独立目录和分支。
 */
export async function mergeWorktree(repo: string, wt: TaskWorktree, message: string) {
  if (existsSync(wt.path)) {
    await git(wt.path, 'add', '-A')
    const dirty = (await git(wt.path, 'diff', '--cached', '--quiet')).code !== 0
    if (dirty) {
      const c = await git(wt.path, ...(await identity(wt.path)), 'commit', '-q', '-m', message)
      if (c.code !== 0) throw fail(c, t('提交改动失败'))
    }
  }
  const target = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  const m = await git(repo, ...(await identity(repo)), 'merge', '--no-ff', '--no-edit', '-m', message, wt.branch)
  if (m.code !== 0) {
    await git(repo, 'merge', '--abort')
    throw new Error(
      t(
        '合并到「{branch}」时有冲突或项目目录里有未提交的改动挡住了，项目目录没有改动。可以在项目里手动合并分支 {name}。',
        {
          branch: target,
          name: wt.branch,
        },
      ) + `\n\n${(m.stderr || m.stdout).trim().split('\n').slice(-6).join('\n')}`,
    )
  }
  await removeWorktree(repo, wt, false)
  return target
}

/** 删掉独立目录；force 时连分支一起删（丢弃），否则分支已经合并，用 -d 删 */
export async function removeWorktree(repo: string, wt: TaskWorktree, force: boolean) {
  await git(repo, 'worktree', 'remove', '--force', wt.path)
  if (existsSync(wt.path)) await rm(wt.path, { recursive: true, force: true }).catch(() => {})
  await git(repo, 'worktree', 'prune')
  await git(repo, 'branch', force ? '-D' : '-d', wt.branch)
}
