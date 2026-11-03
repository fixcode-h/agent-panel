import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Task } from '../shared/schema.ts'
import { capture } from './exec/process.ts'
import { DATA_DIR } from './store.ts'
import { p4Runner, parseZtag, type P4Run } from './p4-split.ts'
import { detectVcs } from './projects-analyze.ts'
import { ownFiles, rel } from './own-changes.ts'

/**
 * cherry-pick 到项目设置的目标（Git 分支 / P4 目标项目路径），由面板执行（用户 2026-10-31 定的强制要求）：
 * 只能搬这个对话自己做的改动。以前只在提示词里要求，Agent 常常按两条分支的差异去同步，
 * 把目标分支故意没有、但不是这次修改的内容也带过去。所以这里逐个核对：
 * - Git：只收这个对话开始之后的普通提交（不收合并提交），提交里的每个文件都必须是这个对话改过的
 * - P4：搬指定 changelist 自己的改动（不要求是这个对话改的，用户 2026-11-02 定的），pending 以打开前的 have 版本、
 *   已提交的以提交前一版为基准，三方合并进目标（只带这次改的那几处）；只在目标建 pending，永远不 submit
 * 有一项不合格整次都不做，写清是哪个提交 / 文件、为什么。
 * 搬的过程中有冲突不撤回（用户 2026-11-03 定的）：Git 停在冲突那个提交上、P4 把冲突标记写进目标文件，
 * 写清冲突在哪、怎么接着做，由用户自己解决
 */

export interface CherryPickArgs {
  /** Git：要搬的提交（这个对话做的） */
  commits?: string[]
  /** P4：要搬的 changelist（pending 或已经 submit 的） */
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
  // 目标分支正好在某个目录里检出：就在那里做（要求干净）；否则在数据目录里给这个仓库 + 分支开一个固定的工作目录检出，
  // 搬完没冲突就删掉；有冲突留着给用户解决（临时目录可能被系统清掉，所以不用 tmp）。不动当前目录
  const listed = (await git(root, 'worktree', 'list', '--porcelain')).stdout
  const holder = listed
    .split('\n\n')
    .find((b) => b.split('\n').includes(`branch refs/heads/${target}`))
    ?.match(/^worktree (.+)$/m)?.[1]
  let dir = holder ?? ''
  let own = false
  if (dir) {
    if ((await git(dir, 'status', '--porcelain', '--untracked-files=no')).stdout.trim())
      return {
        ok: false,
        info: `目标分支「${target}」检出在 ${dir}，那里有没提交的改动（可能是上次 cherry-pick 的冲突还没解决）：请用户先处理掉再 cherry-pick。`,
      }
  } else {
    dir = pickDir(root, target)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await git(root, 'worktree', 'prune')
    await mkdir(path.dirname(dir), { recursive: true })
    const add = await git(root, 'worktree', 'add', dir, target)
    if (add.code !== 0) return { ok: false, info: `没能检出目标分支「${target}」：${add.stderr.trim()}` }
    own = true
  }
  let keep = false
  try {
    const r = await git(dir, 'cherry-pick', '-x', ...picked.map((p) => p.sha))
    if (r.code !== 0) {
      const conflicts = (await git(dir, 'diff', '--name-only', '--diff-filter=U')).stdout.split('\n').filter(Boolean)
      // 没有冲突文件就不是冲突（例如没配提交身份）：照实写 git 的报错，撤回，别说成冲突
      if (!conflicts.length) {
        await git(dir, 'cherry-pick', '--abort')
        return {
          ok: false,
          info: `cherry-pick 到「${target}」失败，已撤回、目标分支没动：${r.stderr.trim().slice(0, 400)}。把报错告诉用户。`,
        }
      }
      // 有冲突：不撤回，停在冲突的那个提交上留给用户解决（用户 2026-11-03 定的）
      keep = true
      const at = (await git(dir, 'rev-parse', 'CHERRY_PICK_HEAD')).stdout.trim()
      // 冲突的是第几个：前面的已经搬好，后面的等 --continue
      const done = Math.max(
        0,
        picked.findIndex((p) => p.sha === at),
      )
      return {
        ok: true,
        info: `cherry-pick 到「${target}」有冲突，停在 ${at.slice(0, 9) || '冲突的提交'} 上，留给用户解决（没有撤回）：\n- 目录：${dir}\n- 冲突文件：${conflicts.join('、')}\n${done > 0 ? `- 前面 ${done} 个提交已经搬好\n` : ''}用户在这个目录里解决冲突、git add 后运行 git cherry-pick --continue 接着搬剩下的；想放弃就 git cherry-pick --abort。把这些告诉用户，不要自己解决冲突，也不要改用别的办法把整份差异搬过去。`,
      }
    }
    const head = (await git(dir, 'rev-parse', '--short', 'HEAD')).stdout.trim()
    return {
      ok: true,
      info: `已把 ${picked.length} 个提交 cherry-pick 到「${target}」（现在是 ${head}）：\n${picked.map((p) => `- ${p.sha.slice(0, 9)} ${p.subject}`).join('\n')}\n没有推送。`,
    }
  } finally {
    if (own && !keep) {
      await git(root, 'worktree', 'remove', '--force', dir)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** 目标分支没在哪里检出时，面板为它开的工作目录：按仓库和分支固定下来，有冲突时用户知道去哪解决 */
function pickDir(root: string, target: string) {
  const id = createHash('sha1')
    .update(`${path.resolve(root)}\n${target}`)
    .digest('hex')
    .slice(0, 10)
  const name = `${path.basename(root)}-${target.replace(/[^\w.-]+/g, '-')}`.slice(0, 60)
  return path.join(DATA_DIR, 'cherry-pick', `${name}-${id}`)
}

/**
 * 已提交的 changelist 里集成类的动作按内容变化归类：integrate 是改了内容，branch / move/add 是多出一个文件，
 * move/delete 是少了一个文件。比较的都是这个 changelist 提交前后两版，搬过去的只是这一次的变化
 */
const ACTION_AS: Record<string, string> = {
  integrate: 'edit',
  branch: 'add',
  'move/add': 'add',
  'move/delete': 'delete',
}

/**
 * depot 路径 → 项目里的相对路径。先按当前工作区的映射（p4 where）找；找不到时多半是这个 changelist
 * 提交在别的 stream 上（例如子流的提交要搬回父流），当前工作区没映射那条流：
 * 按 stream 的层级换算——同一个 depot 里各条流的根目录层数一样，去掉流根、再去掉项目在流里的子目录，
 * 剩下的就是项目里的相对路径（两条流的目录结构是一样的，目标也按这个相对路径找文件）
 */
function streamMapper(root: string, src: P4Run) {
  let layout: Promise<{ depth: number; sub: string } | null> | undefined
  const readLayout = async () => {
    const stream = parseZtag((await src(['-ztag', 'client', '-o'])).out)[0]?.Stream ?? ''
    const proj = parseZtag((await src(['-ztag', 'where', path.join(root, '...')])).out)[0]?.depotFile ?? ''
    if (!stream || !proj.startsWith(`${stream}/`)) return null
    // 项目在流里的子目录：//depot/Dev/Game/... → /Game；项目就是流根时是空串
    const sub = proj.slice(stream.length).replace(/\/\.\.\.$/, '')
    return { depth: stream.split('/').length, sub }
  }
  return async (depot: string) => {
    const where = parseZtag((await src(['-ztag', 'where', depot])).out)[0]
    const local = where?.path ?? ''
    const r = local ? rel(root, local) : ''
    if (r) return { local, rel: r }
    const l = await (layout ??= readLayout())
    if (!l) return { local: '', rel: '' }
    const rest = `/${depot.split('/').slice(l.depth).join('/')}`
    if (l.sub && !rest.startsWith(`${l.sub}/`)) return { local: '', rel: '' }
    const p = rest.slice(l.sub.length + 1)
    return { local: '', rel: p }
  }
}

/** 要搬的一个文件：base 是改之前的版本，mine 是改完的内容（pending 是本地文件，已提交的是打印出来的那一版） */
type P4File = { rel: string; action: string; depot: string; base: string; mine: string }

/**
 * 已提交的 changelist 用 describe 列出来的文件：depotFile0 / action0 / rev0…（同一条记录里按序号排）。
 * 编辑的基准是提交前一版（rev-1），改完的是提交的那一版（rev）
 */
function describedFiles(rec: Record<string, string>) {
  const out: { depot: string; action: string; rev: number }[] = []
  for (let i = 0; `depotFile${i}` in rec; i++)
    out.push({ depot: rec[`depotFile${i}`], action: rec[`action${i}`] ?? '', rev: Number(rec[`rev${i}`]) })
  return out
}

export async function cherryPickP4(
  root: string,
  target: string,
  _task: Pick<Task, 'messages' | 'changes'>,
  changelist: string,
  p4: (cwd: string) => P4Run,
): Promise<Result> {
  const cl = changelist.trim()
  if (!/^\d+$/.test(cl))
    return {
      ok: false,
      info: 'changelist 要写这次改动所在的 changelist 编号：还没提交的 pending（default 里可能混着别的改动，先用 p4_split_changelists 分出来），或者已经 submit 的那个。',
    }
  if (!existsSync(target)) return { ok: false, info: `目标项目路径不存在：${target}。请用户到项目设置里重新填。` }
  const src = p4(root)
  // 先看这个 changelist 是 pending 还是已经 submit：已提交的没有打开的文件，要按提交时的版本取改动
  const head = parseZtag((await src(['-ztag', 'describe', '-s', cl])).out)[0]
  const submitted = head?.status === 'submitted'
  const srcDesc = head?.desc?.trim()
  const listed: { depot: string; action: string; rev?: number }[] = []
  if (submitted) listed.push(...describedFiles(head))
  else {
    const opened = await src(['-ztag', 'opened', '-c', cl])
    if (!opened.ok) return { ok: false, info: `读不出 changelist ${cl}：${opened.err}` }
    listed.push(
      ...parseZtag(opened.out)
        .filter((r) => r.depotFile)
        .map((r) => ({ depot: r.depotFile, action: r.action })),
    )
  }
  if (!listed.length)
    return {
      ok: false,
      info: submitted ? `已提交的 changelist ${cl} 里没有文件。` : `changelist ${cl} 里没有打开的文件。`,
    }
  // 不要求是这个对话改的（用户 2026-11-02 定的：P4 只守「不自己 submit」这一条）：
  // 搬的只是这个 changelist 自己的改动（pending 是打开前到现在、已提交的是提交前后两版之差），
  // 不会带上两条流本来就不同的内容；用户常在 P4V 里提交后让 Agent 搬
  const toRel = streamMapper(root, src)
  const bad: string[] = []
  const picked: (Omit<P4File, 'base' | 'mine'> & { local: string; rev?: number })[] = []
  for (const r of listed) {
    const { local, rel: p } = await toRel(r.depot)
    const action = ACTION_AS[r.action] ?? r.action
    if (!p) bad.push(`${r.depot}：不在项目目录里（对应不到这个项目的目录）`)
    else if (!['edit', 'add', 'delete'].includes(action)) bad.push(`${p}：动作是 ${r.action}，面板只搬编辑、新增、删除`)
    else picked.push({ rel: p, action, local, depot: r.depot, rev: r.rev })
  }
  if (bad.length)
    return {
      ok: false,
      info: `没有 cherry-pick（有一个文件搬不了整次都不做）：\n${bad.map((x) => `- ${x}`).join('\n')}\n把情况告诉用户，由用户决定怎么处理。`,
    }
  // 编辑的文件做三方合并：基准是改之前的版本（pending 是打开前的 have，已提交的是提交前一版），
  // 「我们」是这次改完的，合进目标里的同一个文件。只把这段改动带过去，目标分支本来就不同的地方（哪怕紧挨着改动）
  // 原样保留；真正撞在一起才算冲突。全部先在临时目录里合好，有一个合不上整次都不动目标
  const work = await mkdtemp(path.join(tmpdir(), 'ap-pick-'))
  try {
    const fail: string[] = []
    /** 取一个版本到临时目录：读不出来时记进 fail，返回空 */
    const fetchRev = async (spec: string, file: string, what: string, f: { rel: string }) => {
      const got = await src(['print', '-q', '-o', file, spec])
      if (got.ok && existsSync(file)) return file
      fail.push(`${f.rel}：读不出${what}（${got.err || 'p4 print 没有输出'}）`)
      return ''
    }
    const files: P4File[] = []
    for (const [i, f] of picked.entries()) {
      // 改完的内容：pending 就是本地文件；已提交的取提交的那一版（本地可能已经又改过了）
      // 删除的不需要内容；别的流上提交的文件本地没有对应路径，所以删除不看 local
      if (f.action === 'delete') {
        files.push({ rel: f.rel, action: f.action, depot: f.depot, base: '', mine: '' })
        continue
      }
      const mineFile = !submitted
        ? f.local
        : await fetchRev(`${f.depot}#${f.rev}`, path.join(work, `${i}.mine`), `提交的版本 #${f.rev}`, f)
      if (!mineFile) continue
      let base = ''
      if (f.action === 'edit') {
        const spec = submitted ? `${f.depot}#${(f.rev ?? 1) - 1}` : `${f.depot}#have`
        base = await fetchRev(spec, path.join(work, `${i}.base`), submitted ? '提交前的版本' : '打开前的版本', f)
        if (!base) continue
      }
      files.push({ rel: f.rel, action: f.action, depot: f.depot, base, mine: mineFile })
    }
    // 合不上的不撤回（用户 2026-11-03 定的）：冲突标记写进目标文件照样搬过去，留给用户解决；
    // 只有根本搬不了的（目标里没有这个文件、读不出版本）才跳过并写明
    const merged: { rel: string; file: string; conflict: boolean }[] = []
    /** 三方合并到 theirs（目标文件的副本）：返回 clean / conflict，git merge-file 自己出错时返回空 */
    const merge3 = async (theirs: string, base: string, mine: string) => {
      const m = await capture(
        'git',
        ['merge-file', '-L', 'target', '-L', 'before', '-L', 'mine', theirs, base, mine],
        work,
      )
      // merge-file 的退出码是冲突数（最多 127），负数 / 大于 127 是它自己出错
      if (m.code === 0) return 'clean'
      if (m.code !== null && m.code > 0 && m.code < 128) return 'conflict'
      return ''
    }
    for (const [i, f] of files.filter((x) => x.action === 'edit').entries()) {
      const there = path.join(target, f.rel)
      if (!existsSync(there)) {
        fail.push(`${f.rel}：目标里没有这个文件，跳过（整个文件搬过去会带上这次以外的内容）`)
        continue
      }
      // 打开了但没改（和改之前一样）：不是这次的修改，不搬
      if ((await readFile(f.base)).equals(await readFile(f.mine))) continue
      const theirs = path.join(work, `${i}.target`)
      await copyFile(there, theirs)
      const r = await merge3(theirs, f.base, f.mine)
      if (!r) fail.push(`${f.rel}：git merge-file 出错，跳过`)
      // 结果写回在临时副本里：按字节读回来，换行符、结尾换行都和合并结果一致
      else merged.push({ rel: f.rel, file: theirs, conflict: r === 'conflict' })
    }
    // 新增的文件目标里已经有同名的：以空文件为基准合并，两边的内容都留着、标成冲突
    const adds: { rel: string; file: string; conflict: boolean; exists: boolean }[] = []
    for (const [i, f] of files.filter((x) => x.action === 'add').entries()) {
      const there = path.join(target, f.rel)
      if (!existsSync(there)) {
        adds.push({ rel: f.rel, file: f.mine, conflict: false, exists: false })
        continue
      }
      const theirs = path.join(work, `${i}.add-target`)
      const empty = path.join(work, `${i}.empty`)
      await copyFile(there, theirs)
      await writeFile(empty, '')
      const r = await merge3(theirs, empty, f.mine)
      if (!r) fail.push(`${f.rel}：这次是新增，目标里已经有同名文件，git merge-file 出错，跳过`)
      else adds.push({ rel: f.rel, file: theirs, conflict: r === 'conflict', exists: true })
    }
    if (!merged.length && !adds.length && !files.some((x) => x.action === 'delete'))
      return {
        ok: false,
        info: `没有 cherry-pick，目标没动：\n${fail.map((x) => `- ${x}`).join('\n')}\n把情况告诉用户，由用户决定怎么处理，不要改用整文件覆盖或按目录差异同步。`,
      }
    const dst = p4(target)
    // 新 changelist 沿用来源的描述（按 P4 的规则只建 pending、不 submit），末尾注明从哪个 changelist 搬来。
    // 表单直接从 Node 写进 p4 的标准输入（UTF-8），不经 shell 管道，中文描述不会变成 ???（见 p4.md）
    const desc = `${srcDesc || '改动'}（cherry-pick 自 ${cl}）`
    const made = await dst(['change', '-i'], `Change: new\n\nDescription:\n\t${desc}\n`)
    const num = /Change (\d+) created/.exec(made.out)?.[1]
    if (!num) return { ok: false, info: `没能在目标工作区建 changelist：${made.err || made.out}` }
    const done: string[] = []
    const errs: string[] = []
    const conflicts: string[] = []
    for (const m of merged) {
      const abs = path.join(target, m.rel)
      const e = await dst(['edit', '-c', num, abs])
      if (!e.ok) {
        errs.push(`${m.rel}：p4 edit 失败（${e.err}）`)
        continue
      }
      await copyFile(m.file, abs)
      done.push(`${m.rel}（编辑${m.conflict ? '，有冲突' : ''}）`)
      if (m.conflict) conflicts.push(m.rel)
    }
    for (const f of adds) {
      const abs = path.join(target, f.rel)
      await mkdir(path.dirname(abs), { recursive: true })
      // 目标里本来就有（受版本管理）的要先 edit 才能写
      const open = f.exists ? await dst(['edit', '-c', num, abs]) : null
      if (open && !open.ok) {
        errs.push(`${f.rel}：p4 edit 失败（${open.err}）`)
        continue
      }
      await copyFile(f.file, abs)
      const a = f.exists ? { ok: true, err: '' } : await dst(['add', '-c', num, abs])
      if (!a.ok) errs.push(`${f.rel}：p4 add 失败（${a.err}）`)
      else {
        done.push(`${f.rel}（${f.exists ? '新增，目标里已有同名文件' : '新增'}${f.conflict ? '，有冲突' : ''}）`)
        if (f.conflict) conflicts.push(f.rel)
      }
    }
    for (const f of files.filter((x) => x.action === 'delete')) {
      const d = await dst(['delete', '-c', num, path.join(target, f.rel)])
      if (!d.ok) errs.push(`${f.rel}：p4 delete 失败（${d.err}）`)
      else done.push(`${f.rel}（删除）`)
    }
    const lines = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')
    return {
      ok: done.length > 0,
      info: [
        done.length
          ? `已${submitted ? `把已提交的 changelist ${cl} ` : ''}在目标工作区的 changelist ${num} 里搬好 ${done.length} 个文件：\n${lines(done)}`
          : '',
        conflicts.length
          ? `其中 ${conflicts.length} 个有冲突，冲突标记（<<<<<<< target / >>>>>>> mine）已经写在目标文件里，留给用户解决：\n${lines(conflicts.map((c) => path.join(target, c)))}`
          : '',
        fail.length ? `跳过 ${fail.length} 个：\n${lines(fail)}` : '',
        errs.length ? `有 ${errs.length} 个没搬成：\n${lines(errs)}` : '',
        conflicts.length
          ? '没有 submit。把冲突文件告诉用户，由用户自己解决后再提交，不要自己解决冲突。'
          : '没有 submit。',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/** 用户最近几条消息都算：用户说了「cherry-pick 过去」，Agent 问一句、用户补一句「只要 lua」时，补的那句不用再重复要求 */
const ASK_WINDOW = 3

/**
 * 用户最近几条消息里有没有要 cherry-pick 的意思（用户 2026-10-31 定的：执不执行由用户说了算，Agent 不能自己发起；
 * 2026-11-03 定的：不要求用户按固定说法回复）：提到 cherry-pick / cp，或者「合 / 搬 / 同步 / 挑 / 移植 / 弄 / 带」过去、到某处，「提 / 拿」过去（「提到」「拿到」是别的意思，不算），
 * 或者点了目标的名字。只看用户自己发的消息：面板推的、父子对话之间传的都不算
 */
export function userAsked(task: Pick<Task, 'messages'>, target: string): boolean {
  const said = task.messages
    .filter((m) => m.role === 'user' && !m.panel && !m.peer && !m.child)
    .slice(-ASK_WINDOW)
    .map((m) => (m.text ?? '').toLowerCase())
  const name = target.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? ''
  return said.some(
    (text) =>
      /cherry[\s-]?pick|\bcp\b|(合并|合|搬|同步|挑|移植|弄|带|放)(到|过去|进)|(提|拿)过去/.test(text) ||
      (!!name && text.includes(name)),
  )
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
        info: '用户最近没有要求 cherry-pick：这个工具只在用户要求把改动搬到目标时才能用，不能自己发起。需要的话问用户要不要搬过去（不用让用户按固定说法回复，用户说要搬就行）。',
      })
    return vcs === 'git'
      ? cherryPickGit(dir, target, task(), input.commits ?? [])
      : cherryPickP4(dir, target, task(), input.changelist ?? '', p4Runner)
  }
}
