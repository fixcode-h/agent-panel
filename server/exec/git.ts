import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FileChange } from '../../shared/schema.ts'
import { capture } from './process.ts'
import { t } from '../../shared/i18n.ts'
import { lines } from './parsers.ts'

const git = (cwd: string, ...args: string[]) => capture('git', ['-c', 'core.quotepath=off', ...args], cwd)

/**
 * 面板自己往任务目录里放的东西不算 Agent 的改动：拷进对话目录的图片会让 git
 * 把它当未跟踪文件列出来，看起来像是 Agent 新加的文件。
 * 排除名单由调用方从任务上记的 placedAttachments 传进来（见 server/attachments.ts），不按文件名猜。
 */
export type PlacedFiles = Iterable<string>

/** 相对路径按 git 的样子写（`/` 分隔、去掉开头的 `./`），和 ls-files 的输出对得上 */
const relPath = (p: string) => (p.startsWith('./') ? p.slice(2) : p).split(path.sep).join('/')

/** 只收任务目录里的相对路径：绝对路径和带 `..` 的一律不算，免得排除到别处去 */
function placedSet(ignore?: PlacedFiles) {
  const out = new Set<string>()
  for (const p of ignore ?? []) {
    const rel = relPath(p)
    if (rel && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.split('/').includes('..')) out.add(rel)
  }
  return out
}

/**
 * 当前未提交的改动：path → "增加/删除" 行数。不是 git 仓库时返回 null。
 * 包含未跟踪的新文件（按行数算新增）。
 */
export async function gitNumstat(cwd: string, ref = '', ignore?: PlacedFiles): Promise<Record<string, string> | null> {
  const inside = await git(cwd, 'rev-parse', '--is-inside-work-tree')
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  // 和任务开始时的提交比：Agent 自己提交了的改动也算在内，不会因为提交就从「更改」里消失
  const base = ref && (await git(cwd, 'cat-file', '-e', `${ref}^{commit}`)).code === 0 ? ref : 'HEAD'
  const hasBase = (await git(cwd, 'rev-parse', '--verify', base)).code === 0
  const diff = await git(cwd, 'diff', '--numstat', ...(hasBase ? [base] : ['--cached']))
  const skip = placedSet(ignore)
  const out: Record<string, string> = {}
  for (const line of diff.stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (m && !skip.has(relPath(m[3]))) out[m[3]] = `${m[1] === '-' ? 0 : m[1]}/${m[2] === '-' ? 0 : m[2]}`
  }
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard')
  for (const p of untracked.stdout.split('\n').filter(Boolean).slice(0, 300)) {
    if (skip.has(relPath(p))) continue
    try {
      const full = path.join(cwd, p)
      const s = await stat(full)
      const n = s.size > 2_000_000 ? 0 : lines(await readFile(full, 'utf8'))
      out[p] = `${n}/0`
    } catch {}
  }
  return out
}

/** 当前提交；不是 git 仓库或还没有提交时为空 */
export async function gitHead(cwd: string) {
  const r = await git(cwd, 'rev-parse', '--verify', 'HEAD')
  return r.code === 0 ? r.stdout.trim() : ''
}

/** 和任务开始时相比有变化的文件；ref 是任务开始时的提交 */
export async function gitChanges(
  cwd: string,
  baseline: Record<string, string>,
  ref = '',
  ignore?: PlacedFiles,
): Promise<FileChange[] | null> {
  const now = await gitNumstat(cwd, ref, ignore)
  if (!now) return null
  return Object.entries(now)
    .filter(([p, v]) => baseline[p] !== v)
    .map(([p, v]) => {
      const [add, del] = v.split('/').map(Number)
      return { path: p, add, del }
    })
}

/** 配了远端没有（没有远端的仓库推不了，父对话的推送收尾也就没有意义） */
export async function gitHasRemote(cwd: string): Promise<boolean> {
  const r = await git(cwd, 'remote')
  return r.code === 0 && r.stdout.trim() !== ''
}

/** 本地分支，最近提交的排在前面；current 是当前所在的分支（分离 HEAD 时为空） */
export async function gitBranches(cwd: string): Promise<{ current: string | null; branches: string[] }> {
  const list = await git(cwd, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads')
  if (list.code !== 0) throw new Error(t('这个目录不是 git 仓库'))
  const head = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  const current = head.code === 0 && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : null
  return {
    current,
    branches: list.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

/**
 * 切换到已有分支。只接受本地分支，分支名不从界面上随便传；
 * 有未提交的改动挡住时把 git 的说明原样交给用户。
 */
export async function gitCheckout(cwd: string, branch: string) {
  const { branches } = await gitBranches(cwd)
  if (!branches.includes(branch)) throw new Error(t('没有这个分支：{branch}', { branch }))
  const r = await capture('git', ['-c', 'core.quotepath=off', 'checkout', branch], cwd, process.env, 60_000)
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || t('切换分支失败'))
}

const MAX_DIFF = 400_000

/** 起点：任务开始时的提交还在就用它，否则用当前提交 */
async function baseOf(cwd: string, ref: string) {
  if (ref && (await git(cwd, 'cat-file', '-e', `${ref}^{commit}`)).code === 0) return ref
  return (await git(cwd, 'rev-parse', '--verify', 'HEAD')).code === 0 ? 'HEAD' : ''
}

/** 一个文件和任务开始时相比的差异（unified diff）；新文件和整个文件都是新增 */
export async function gitFileDiff(cwd: string, ref: string, file: string) {
  const base = await baseOf(cwd, ref)
  let out = base ? (await git(cwd, 'diff', '--no-color', base, '--', file)).stdout : ''
  if (!out.trim()) {
    // 没跟踪的新文件：和空文件比
    const tracked = (await git(cwd, 'ls-files', '--error-unmatch', '--', file)).code === 0
    if (!tracked) out = (await git(cwd, 'diff', '--no-color', '--no-index', '--', '/dev/null', file)).stdout
  }
  return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n${t('…（差异太长，只显示前面一部分）')}` : out
}

/**
 * 把一个文件恢复成任务开始时的样子：开始时就有的文件取回那时的内容，任务里新建的直接删掉。
 * 任务开始前就有未提交改动的文件不能恢复（那些改动没有保存过，恢复会一起丢掉），由调用方拦住。
 */
export async function gitRevertFile(cwd: string, ref: string, file: string) {
  const base = await baseOf(cwd, ref)
  const full = path.resolve(cwd, file)
  if (!full.startsWith(path.resolve(cwd) + path.sep)) throw new Error(t('文件不在项目目录里'))
  const existed = base && (await git(cwd, 'cat-file', '-e', `${base}:${file}`)).code === 0
  if (existed) {
    const r = await git(cwd, 'checkout', base, '--', file)
    if (r.code !== 0) throw new Error(r.stderr.trim() || t('恢复失败'))
    // checkout 会把文件放进暂存区，和开始时一样不留暂存
    await git(cwd, 'reset', '-q', '--', file)
  } else {
    await git(cwd, 'rm', '-q', '--cached', '--ignore-unmatch', '--', file)
    await unlink(full).catch((e) => {
      if (e?.code !== 'ENOENT') throw e
    })
  }
}

/** ref 之后这个分支上的提交（一行一个「短哈希 标题」），给交接摘要用；读不出来返回空 */
export async function branchCommits(cwd: string, ref: string, max = 20): Promise<string[]> {
  if (!ref) return []
  const r = await git(cwd, 'log', '--oneline', '--no-decorate', `-${max}`, `${ref}..HEAD`)
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
}

/**
 * 工作区现在的样子写成一棵树（含没跟踪的新文件），用一个临时暂存区，不碰真正的暂存区和提交。
 * 评审要「上一轮评审之后改了什么」：记下这棵树，下一轮和它比就是增量。读不出来返回空
 */
export async function gitSnapshot(cwd: string, ignore?: PlacedFiles): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ap-snap-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') }
  const run = (...args: string[]) => capture('git', ['-c', 'core.quotepath=off', ...args], cwd, env, 30_000)
  try {
    // 从真正的暂存区拷一份起步：里面有文件的时间戳和大小，add 只需重新读改过的文件；
    // 只 read-tree HEAD 的话每个文件都要重新算哈希，大仓库每轮对话都这样做会卡好几秒
    const index = (await git(cwd, 'rev-parse', '--git-path', 'index')).stdout.trim()
    const source = index && path.resolve(cwd, index)
    const seeded =
      !!source &&
      (await copyFile(source, env.GIT_INDEX_FILE)
        // 拷贝要带上原暂存区的修改时间：git 靠「条目时间不早于暂存区文件时间」认出同一秒里改过的文件再去比内容，
        // 拷出来的文件时间是现在，同一秒里改了、大小又没变的文件就被当成没改，这一轮的改动整个漏掉
        .then(() => stat(source))
        .then((st) => utimes(env.GIT_INDEX_FILE, st.atime, st.mtime))
        .then(
          () => true,
          () => false,
        ))
    const head = (await git(cwd, 'rev-parse', '--verify', 'HEAD')).code === 0
    if (!seeded && head && (await run('read-tree', 'HEAD')).code !== 0) return ''
    // 面板放进来的附件不是改动（见 placedSet）；literal 让文件名里的 * ? [ 按字面比较
    const paths = ['.', ...[...placedSet(ignore)].map((p) => `:(exclude,literal)${p}`)]
    if ((await run('add', '-A', '--', ...paths)).code !== 0) return ''
    const tree = await run('write-tree')
    return tree.code === 0 ? tree.stdout.trim() : ''
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 一次交给评审的差异上限（字）：再长就只附文件列表，完整差异另存文件 */
const REVIEW_DIFF_MAX = 60_000
/** 每处改动前后带几行没改的代码：够看懂改动在哪、接着什么，又不至于把整个函数（几千行的组件）都带进来 */
const REVIEW_CONTEXT = 10
/** 太长时退回的上下文行数 */
const REVIEW_CONTEXT_SHORT = 3
/**
 * 只列进文件清单、不放进差异正文的文件：锁文件、压缩产物、快照这类机器生成的内容，
 * 评审看不出对错，却能把一份差异撑过上限（一次依赖升级的 package-lock.json 就有上万行）
 */
export const REVIEW_SKIP = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'composer.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
]
const skipSpecs = REVIEW_SKIP.map((p) => `:(exclude,glob)**/${p}`)

/**
 * 交给评审的改动（ADR 0010、0013）：since 给了就是上一轮评审之后的增量，否则是任务开始以来的全部改动。
 * files 给了就只取这些文件（空数组就是没有改动）：对话开得久时任务基线早，基线之后合进来的子对话、别人的提交都会算进「全部改动」，
 * 评审只该看这一次要它评的那几个文件。
 * 每处改动只带前后几行（不用 -W 带整个函数）：评审只评改动的行，几千行的组件整个函数塞进去既撑大提示词，
 * 又引着它去评没改的代码。太长时退回更少的上下文，仍太长由调用方存文件
 */
export async function reviewDiff(cwd: string, ref: string, since = '', files?: string[], ignore?: PlacedFiles) {
  const snapshot = await gitSnapshot(cwd, ignore)
  if (!snapshot) return null
  const from = since || (await baseOf(cwd, ref))
  if (!from) return null
  // 点名了文件却一个都没有：这个对话没改过文件
  if (files && !files.length) return { snapshot, from, stat: '', diff: '', full: '' }
  const scope = files ? ['--', ...files] : ['--', '.']
  const stat = (await git(cwd, 'diff', '--stat=120', from, snapshot, ...scope)).stdout.trim()
  if (!stat) return { snapshot, from, stat: '', diff: '', full: '' }
  const body = [...scope, ...skipSpecs]
  const full = (await git(cwd, 'diff', '--no-color', `-U${REVIEW_CONTEXT}`, from, snapshot, ...body)).stdout
  const diff =
    full.length <= REVIEW_DIFF_MAX
      ? full
      : (await git(cwd, 'diff', '--no-color', `-U${REVIEW_CONTEXT_SHORT}`, from, snapshot, ...body)).stdout
  return { snapshot, from, stat, diff: diff.length <= REVIEW_DIFF_MAX ? diff : '', full }
}

/** 一段改动：from、to 都是 gitSnapshot 记下的树 */
export interface TreeSpan {
  from: string
  to: string
}

/**
 * 几段改动合起来改了哪些文件、各增删多少行（按出现的先后排）。
 * 不认重命名：改名记成删掉旧文件、新建新文件，撤销时也按这两步各自回退
 */
export async function spansNumstat(cwd: string, spans: TreeSpan[]): Promise<FileChange[]> {
  const out = new Map<string, FileChange>()
  for (const s of spans) {
    if (s.from === s.to) continue
    const r = await git(cwd, 'diff', '--numstat', '--no-renames', s.from, s.to)
    if (r.code !== 0) throw new Error(r.stderr.trim() || t('读不出改动'))
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      const add = m[1] === '-' ? 0 : Number(m[1])
      const del = m[2] === '-' ? 0 : Number(m[2])
      const had = out.get(m[3])
      if (had) {
        had.add += add
        had.del += del
      } else out.set(m[3], { path: m[3], add, del })
    }
  }
  return [...out.values()]
}

/** 一个文件在几段改动里的差异，按先后拼起来 */
export async function spansFileDiff(cwd: string, spans: TreeSpan[], file: string) {
  const parts: string[] = []
  for (const s of spans) {
    if (s.from === s.to) continue
    const r = await git(cwd, 'diff', '--no-color', '--no-renames', s.from, s.to, '--', file)
    if (r.code !== 0) throw new Error(r.stderr.trim() || t('读不出改动'))
    if (r.stdout.trim()) parts.push(r.stdout)
  }
  const out = parts.join('\n')
  return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n${t('…（差异太长，只显示前面一部分）')}` : out
}

/** 二进制安全地跑一次 git：cat-file、merge-file 的输出不能按行拆 */
function gitRaw(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout: stdout ?? Buffer.alloc(0), stderr: stderr?.toString() ?? '' })
      },
    )
  })
}

/**
 * 树里一个文件的内容，按检出到工作区的样子给（换行符、过滤器都按仓库设置转换）：
 * Windows 上 autocrlf 时树里存的是 LF、工作区是 CRLF，直接比会每一行都对不上。没有这个文件返回 null
 */
async function blobAt(cwd: string, tree: string, file: string): Promise<Buffer | null> {
  const r = await gitRaw(cwd, ['cat-file', '--filters', `${tree}:${file}`])
  if (r.code === 0) return r.stdout
  // 树本身不在了（太久以前的快照被 git 清理了）和「这个文件不在树里」要分开：前者不能当成文件不存在
  const tree0 = await gitRaw(cwd, ['cat-file', '-e', `${tree}^{tree}`])
  if (tree0.code !== 0) throw new Error(t('改动记录已经被 git 清理，没法撤销'))
  return null
}

const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b))

/** 三方合并一个文件：在 mine 上撤掉 base → other 的改动。有冲突或是二进制文件时返回 null */
async function mergeText(cwd: string, mine: Buffer, base: Buffer, other: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ap-undo-'))
  try {
    const f = (n: string) => path.join(dir, n)
    await Promise.all([writeFile(f('mine'), mine), writeFile(f('base'), base), writeFile(f('other'), other)])
    // 退出码是冲突的个数，负数是出错（含二进制文件）
    const r = await gitRaw(cwd, ['merge-file', '-p', f('mine'), f('base'), f('other')])
    return r.code === 0 ? r.stdout : null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export interface UndoConflict {
  path: string
  reason: string
}

/**
 * 撤销几段改动（一轮对话改的文件）：只撤这几段自己的改动，之后别人（用户、后面几轮）又改的地方保留。
 * 每个文件从现在的内容出发，按从后往前的顺序撤掉每一段：
 * - 现在的内容就是这段改完的样子：直接换回改之前的
 * - 已经是改之前的样子：这段已经撤过了，跳过
 * - 之后又改过：做三方合并，只撤这段的改动；改到了同一处、或是二进制文件，就算冲突
 * 有任何一个文件冲突时一个都不写，把冲突列出来交给调用方；全部算好再一起写进工作区。
 * 只改工作区的文件，不碰暂存区和提交（Agent 这一轮提交过的话，撤销后会多出没提交的改动）
 */
export async function undoSpans(
  cwd: string,
  spans: TreeSpan[],
  files: string[],
): Promise<{ ok: true; files: string[] } | { ok: false; conflicts: UndoConflict[] }> {
  const root = path.resolve(cwd)
  const plan = new Map<string, Buffer | null>()
  const conflicts: UndoConflict[] = []
  for (const file of files) {
    const full = path.resolve(root, file)
    if (!full.startsWith(root + path.sep)) {
      conflicts.push({ path: file, reason: t('文件不在项目目录里') })
      continue
    }
    let cur: Buffer | null = await readFile(full).catch((e) => {
      if (e?.code === 'ENOENT') return null
      throw e
    })
    let bad = ''
    for (const s of [...spans].reverse()) {
      if (s.from === s.to) continue
      const [before, after] = await Promise.all([blobAt(cwd, s.from, file), blobAt(cwd, s.to, file)])
      if (same(before, after)) continue
      if (same(cur, after)) {
        cur = before
        continue
      }
      if (same(cur, before)) continue
      // 之后又改过：新建的文件被改了、删掉的文件又建回来了，都没法只撤这一段
      if (cur === null) {
        bad = t('这个文件后来被删掉了')
        break
      }
      if (before === null) {
        bad = t('这一轮新建的文件后来又被改过')
        break
      }
      if (after === null) {
        bad = t('这一轮删掉的文件后来又建了回来')
        break
      }
      const merged = await mergeText(cwd, cur, after, before)
      if (!merged) {
        bad = t('这一轮改过的地方后来又被改过')
        break
      }
      cur = merged
    }
    if (bad) conflicts.push({ path: file, reason: bad })
    else plan.set(file, cur)
  }
  if (conflicts.length) return { ok: false, conflicts }
  const done: string[] = []
  for (const [file, content] of plan) {
    const full = path.resolve(root, file)
    const now = await readFile(full).catch(() => null)
    if (same(now, content)) continue
    if (content === null) {
      await unlink(full).catch((e) => {
        if (e?.code !== 'ENOENT') throw e
      })
      // Agent 这一轮 add 过的新文件：暂存区里也去掉，不然 git status 里留一条「新增后删除」
      if ((await git(cwd, 'cat-file', '-e', `HEAD:${file}`)).code !== 0)
        await git(cwd, 'rm', '-q', '--cached', '--ignore-unmatch', '--', file)
    } else {
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content)
    }
    done.push(file)
  }
  return { ok: true, files: done }
}
