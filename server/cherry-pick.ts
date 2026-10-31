import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '../shared/schema.ts'
import { capture } from './exec/process.ts'
import { p4Runner, parseZtag, type P4Run } from './p4-split.ts'
import { detectVcs } from './projects-analyze.ts'
import { ownFiles, rel } from './own-changes.ts'

/**
 * cherry-pick 到项目设置的目标（Git 分支 / P4 目标项目路径），由面板执行（用户 2026-10-31 定的强制要求）：
 * 只能搬这个对话自己做的改动。以前只在提示词里要求，Agent 常常按两条分支的差异去同步，
 * 把目标分支故意没有、但不是这次修改的内容也带过去。所以这里逐个核对：
 * - Git：只收这个对话开始之后的普通提交（不收合并提交），提交里的每个文件都必须是这个对话改过的
 * - P4：只收指定 changelist 里这个对话改过的文件，以打开前的 have 版本为基准三方合并进目标（只带这次改的那几处）
 * 有一项不合格整次都不做，写清是哪个提交 / 文件、为什么
 */

export interface CherryPickArgs {
  /** Git：要搬的提交（这个对话做的） */
  commits?: string[]
  /** P4：要搬的 pending changelist */
  changelist?: string
}

type Result = { ok: boolean; info: string }

const git = (cwd: string, ...args: string[]) =>
  capture('git', ['-c', 'core.quotepath=off', ...args], cwd, process.env, 60_000)

export { ownFiles }

export async function cherryPickGit(
  root: string,
  target: string,
  task: Pick<Task, 'messages' | 'changes' | 'createdAt'>,
  commits: string[],
): Promise<Result> {
  if (!commits.length)
    return { ok: false, info: 'commits 是空的：列出这个对话里你自己做的提交（git log 查到的哈希），按做的先后顺序。' }
  if ((await git(root, 'rev-parse', '--verify', `refs/heads/${target}`)).code !== 0)
    return { ok: false, info: `本地没有分支「${target}」：请用户到项目设置里重新选 cherry-pick 目标。` }
  const mine = ownFiles(task, root)
  const since = Date.parse(task.createdAt) / 1000
  const bad: string[] = []
  const picked: { sha: string; at: number; subject: string }[] = []
  for (const c of commits.map((x) => x.trim()).filter(Boolean)) {
    const r = await git(root, 'rev-parse', '--verify', `${c}^{commit}`)
    if (r.code !== 0) {
      bad.push(`${c}：不是这个仓库里的提交`)
      continue
    }
    const sha = r.stdout.trim()
    const info = (await git(root, 'show', '-s', '--format=%P%n%ct%n%s', sha)).stdout.split('\n')
    if ((info[0] ?? '').trim().split(/\s+/).length > 1) {
      bad.push(`${sha.slice(0, 9)}：是合并提交，合并带进来的是别的分支的内容，不能搬`)
      continue
    }
    const at = Number(info[1])
    if (Number.isFinite(since) && at < since - 60) {
      bad.push(`${sha.slice(0, 9)}「${info[2]}」：在这个对话开始之前就提交了，不是这个对话做的`)
      continue
    }
    if ((await git(root, 'merge-base', '--is-ancestor', sha, `refs/heads/${target}`)).code === 0) {
      bad.push(`${sha.slice(0, 9)}「${info[2]}」：目标分支上已经有了`)
      continue
    }
    const files = (await git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha)).stdout
      .split('\n')
      .filter(Boolean)
    const foreign = files.filter((f) => !mine.has(f))
    if (foreign.length) {
      bad.push(
        `${sha.slice(0, 9)}「${info[2]}」：改了这个对话没改过的文件（${foreign.slice(0, 5).join('、')}${foreign.length > 5 ? ' 等' : ''}），不是只含这次修改的提交`,
      )
      continue
    }
    picked.push({ sha, at, subject: info[2] ?? '' })
  }
  if (bad.length)
    return {
      ok: false,
      info: `没有 cherry-pick（只能搬这个对话自己做的提交，有一个不合格整次都不做）：\n${bad.map((x) => `- ${x}`).join('\n')}\n只列这个对话里你自己做的、只含这次修改的提交再调用；需要的话先把这次的改动单独提交。`,
    }
  // 按提交时间排：先做的先搬，后面的提交才能接得上
  picked.sort((a, b) => a.at - b.at)
  // 目标分支正好在某个目录里检出：就在那里做（要求干净）；否则开一个临时目录检出目标分支，做完删掉，不动当前目录
  const listed = (await git(root, 'worktree', 'list', '--porcelain')).stdout
  const holder = listed
    .split('\n\n')
    .find((b) => b.split('\n').includes(`branch refs/heads/${target}`))
    ?.match(/^worktree (.+)$/m)?.[1]
  let dir = holder ?? ''
  let temp = ''
  if (dir) {
    if ((await git(dir, 'status', '--porcelain', '--untracked-files=no')).stdout.trim())
      return {
        ok: false,
        info: `目标分支「${target}」检出在 ${dir}，那里有没提交的改动：请用户先处理掉再 cherry-pick。`,
      }
  } else {
    temp = await mkdtemp(path.join(tmpdir(), 'ap-pick-'))
    dir = path.join(temp, 'wt')
    const add = await git(root, 'worktree', 'add', dir, target)
    if (add.code !== 0) {
      await rm(temp, { recursive: true, force: true }).catch(() => {})
      return { ok: false, info: `没能检出目标分支「${target}」：${add.stderr.trim()}` }
    }
  }
  try {
    const r = await git(dir, 'cherry-pick', '-x', ...picked.map((p) => p.sha))
    if (r.code !== 0) {
      const conflicts = (await git(dir, 'diff', '--name-only', '--diff-filter=U')).stdout.split('\n').filter(Boolean)
      await git(dir, 'cherry-pick', '--abort')
      return {
        ok: false,
        // 没有冲突文件就不是冲突（例如没配提交身份）：照实写 git 的报错，别说成冲突
        info: conflicts.length
          ? `cherry-pick 到「${target}」有冲突，已全部撤回、目标分支没动（冲突文件：${conflicts.join('、')}）。把冲突情况告诉用户，由用户决定怎么处理，不要改用别的办法把整份差异搬过去。`
          : `cherry-pick 到「${target}」失败，已撤回、目标分支没动：${r.stderr.trim().slice(0, 400)}。把报错告诉用户。`,
      }
    }
    const head = (await git(dir, 'rev-parse', '--short', 'HEAD')).stdout.trim()
    return {
      ok: true,
      info: `已把 ${picked.length} 个提交 cherry-pick 到「${target}」（现在是 ${head}）：\n${picked.map((p) => `- ${p.sha.slice(0, 9)} ${p.subject}`).join('\n')}\n没有推送。`,
    }
  } finally {
    if (temp) {
      await git(root, 'worktree', 'remove', '--force', dir)
      await rm(temp, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export async function cherryPickP4(
  root: string,
  target: string,
  task: Pick<Task, 'messages' | 'changes'>,
  changelist: string,
  p4: (cwd: string) => P4Run,
): Promise<Result> {
  const cl = changelist.trim()
  if (!/^\d+$/.test(cl))
    return {
      ok: false,
      info: 'changelist 要写这个对话的 pending changelist 编号（default 里可能混着别的改动，先用 p4_split_changelists 分出来）。',
    }
  if (!existsSync(target)) return { ok: false, info: `目标项目路径不存在：${target}。请用户到项目设置里重新填。` }
  const src = p4(root)
  const opened = await src(['-ztag', 'opened', '-c', cl])
  if (!opened.ok) return { ok: false, info: `读不出 changelist ${cl}：${opened.err}` }
  const recs = parseZtag(opened.out).filter((r) => r.depotFile)
  if (!recs.length) return { ok: false, info: `changelist ${cl} 里没有打开的文件。` }
  const mine = ownFiles(task, root)
  const bad: string[] = []
  const files: { rel: string; action: string; local: string; depot: string }[] = []
  for (const r of recs) {
    const where = parseZtag((await src(['-ztag', 'where', r.depotFile])).out)[0]
    const local = where?.path ?? ''
    const p = local ? rel(root, local) : ''
    if (!p) bad.push(`${r.depotFile}：不在项目目录里`)
    else if (!mine.has(p)) bad.push(`${p}：这个对话没有改过它，不是这次的修改`)
    else if (!['edit', 'add', 'delete'].includes(r.action))
      bad.push(`${p}：动作是 ${r.action}，面板只搬编辑、新增、删除`)
    else files.push({ rel: p, action: r.action, local, depot: r.depotFile })
  }
  if (bad.length)
    return {
      ok: false,
      info: `没有 cherry-pick（只能搬这个对话自己改的文件，有一个不合格整次都不做）：\n${bad.map((x) => `- ${x}`).join('\n')}\n把不属于这次修改的文件挪出这个 changelist 再调用。`,
    }
  // 编辑的文件做三方合并：基准是打开前的 have 版本，「我们」是这次改完的，合进目标里的同一个文件。
  // 只把 have → 现在 这段改动带过去，目标分支本来就不同的地方（哪怕紧挨着改动）原样保留；真正撞在一起才算冲突。
  // 全部先在临时目录里合好，有一个合不上整次都不动目标
  const work = await mkdtemp(path.join(tmpdir(), 'ap-pick-'))
  try {
    const merged: { rel: string; file: string }[] = []
    const fail: string[] = []
    for (const [i, f] of files.filter((x) => x.action === 'edit').entries()) {
      const there = path.join(target, f.rel)
      if (!existsSync(there)) {
        fail.push(`${f.rel}：目标里没有这个文件`)
        continue
      }
      const base = path.join(work, `${i}.base`)
      const theirs = path.join(work, `${i}.target`)
      const got = await src(['print', '-q', '-o', base, `${f.depot}#have`])
      if (!got.ok || !existsSync(base)) {
        fail.push(`${f.rel}：读不出打开前的版本（${got.err || 'p4 print 没有输出'}）`)
        continue
      }
      // 打开了但没改（和 have 一样）：不是这次的修改，不搬
      if ((await readFile(base)).equals(await readFile(f.local))) continue
      await copyFile(there, theirs)
      const m = await capture(
        'git',
        ['merge-file', '-L', 'target', '-L', 'have', '-L', 'mine', theirs, base, f.local],
        work,
      )
      if (m.code !== 0) fail.push(`${f.rel}：这次的改动和目标里的内容撞在一起了，合不上`)
      // 结果写回在临时副本里：按字节读回来，换行符、结尾换行都和合并结果一致
      else merged.push({ rel: f.rel, file: theirs })
    }
    for (const f of files.filter((x) => x.action === 'add'))
      if (existsSync(path.join(target, f.rel))) fail.push(`${f.rel}：这次是新增，目标里已经有同名文件`)
    if (fail.length)
      return {
        ok: false,
        info: `没有 cherry-pick，目标没动：\n${fail.map((x) => `- ${x}`).join('\n')}\n把情况告诉用户，由用户决定怎么处理，不要改用整文件覆盖或按目录差异同步。`,
      }
    const dst = p4(target)
    // 新 changelist 沿用来源的描述（按 P4 的规则只建 pending、不 submit），末尾注明从哪个 changelist 搬来。
    // 表单直接从 Node 写进 p4 的标准输入（UTF-8），不经 shell 管道，中文描述不会变成 ???（见 p4.md）
    const srcDesc = (await src(['-ztag', 'describe', '-s', cl])).out.match(/^\.\.\. desc (.*)$/m)?.[1]?.trim()
    const desc = `${srcDesc || '改动'}（cherry-pick 自 ${cl}）`
    const made = await dst(['change', '-i'], `Change: new\n\nDescription:\n\t${desc}\n`)
    const num = /Change (\d+) created/.exec(made.out)?.[1]
    if (!num) return { ok: false, info: `没能在目标工作区建 changelist：${made.err || made.out}` }
    const done: string[] = []
    const errs: string[] = []
    for (const m of merged) {
      const abs = path.join(target, m.rel)
      const e = await dst(['edit', '-c', num, abs])
      if (!e.ok) {
        errs.push(`${m.rel}：p4 edit 失败（${e.err}）`)
        continue
      }
      await copyFile(m.file, abs)
      done.push(`${m.rel}（编辑）`)
    }
    for (const f of files.filter((x) => x.action === 'add')) {
      const abs = path.join(target, f.rel)
      await mkdir(path.dirname(abs), { recursive: true })
      await copyFile(f.local, abs)
      const a = await dst(['add', '-c', num, abs])
      if (!a.ok) errs.push(`${f.rel}：p4 add 失败（${a.err}）`)
      else done.push(`${f.rel}（新增）`)
    }
    for (const f of files.filter((x) => x.action === 'delete')) {
      const d = await dst(['delete', '-c', num, path.join(target, f.rel)])
      if (!d.ok) errs.push(`${f.rel}：p4 delete 失败（${d.err}）`)
      else done.push(`${f.rel}（删除）`)
    }
    return {
      ok: !errs.length,
      info: `${done.length ? `已在目标工作区的 changelist ${num} 里搬好 ${done.length} 个文件：\n${done.map((x) => `- ${x}`).join('\n')}\n` : ''}${errs.length ? `有 ${errs.length} 个没搬成：\n${errs.map((x) => `- ${x}`).join('\n')}\n` : ''}没有 submit。`,
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 用户最近一条消息里有没有要 cherry-pick 的意思（用户 2026-10-31 定的：执不执行由用户说了算，Agent 不能自己发起）：
 * 提到 cherry-pick，或者「合并 / 合 / 搬 / 同步 / 挑 / 移植」到某处，或者点了目标的名字。
 * 只看用户自己发的消息：面板推的、父子对话之间传的都不算
 */
export function userAsked(task: Pick<Task, 'messages'>, target: string): boolean {
  const last = [...task.messages].reverse().find((m) => m.role === 'user' && !m.panel && !m.peer && !m.child)
  const text = (last?.text ?? '').toLowerCase()
  if (!text) return false
  if (/cherry[\s-]?pick|\bcp\b|合并到|合到|合进|搬到|搬过去|同步到|挑到|移植到|带到|放到.*分支/.test(text)) return true
  const name = target.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? ''
  return !!name && text.includes(name)
}

/**
 * 给这一轮的对话接上 cherry_pick：按项目目录的版本管理选 Git / P4，两种都不是时不给工具。
 * dir 是对话的工作目录（独立分支时是 worktree，提交和改过的文件都按它算）；task 取现值，工具调用时读最新的消息
 */
export async function cherryPickFor(dir: string, projectPath: string, target: string, task: () => Task) {
  const vcs = (await detectVcs(projectPath).catch(() => null))?.vcs
  if (vcs !== 'git' && vcs !== 'p4') return undefined
  return (input: CherryPickArgs): Promise<Result> => {
    if (!userAsked(task(), target))
      return Promise.resolve({
        ok: false,
        info: '用户这次没有要求 cherry-pick：这个工具只在用户明确要求把改动 cherry-pick / 合到目标时才能用，不能自己发起。需要的话在回复里问用户。',
      })
    return vcs === 'git'
      ? cherryPickGit(dir, target, task(), input.commits ?? [])
      : cherryPickP4(dir, target, task(), input.changelist ?? '', p4Runner)
  }
}
