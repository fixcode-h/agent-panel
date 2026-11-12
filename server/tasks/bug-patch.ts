/**
 * 排查补丁放到用户工作区 / 还原（分析稿 B1，规则和类型在 shared/bug-patch.ts）：
 * - 放：取独立分支里这几个文件相对分支起点的 diff，先 `git apply --check`，过了才给项目目录里这几个文件拍快照、打补丁；
 *   对不上（用户在这些文件里有没提交的改动且和补丁冲突）就什么都不动，把 git 的说明原样给用户；
 * - 还原：把这几个文件写回快照的内容，再读一遍核对一致；放了之后用户又改过的不覆盖，列出是哪几个文件。
 * 只动项目目录里补丁碰到的那几个文件的工作区内容，不动暂存区、不提交、不整目录还原。
 * 状态和快照存在调用方给的目录（对话数据目录下），不进仓库
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import {
  applyErrorLines,
  PATCH_ABSENT,
  restoreConflicts,
  type PatchKind,
  type PatchState,
  type PatchStatus,
} from '../../shared/bug-patch.ts'
import { gitExec } from '../exec/git.ts'

/** 一条 git 最多等这么久；补丁再大也就是几个文件 */
const GIT_OPTS = { timeoutMs: 20_000, maxBuffer: 64 << 20 } as const

export interface PatchDirs {
  /** 对话的独立分支目录 */
  wt: string
  /** 用户的项目目录 */
  project: string
  /** 分支起点：对话开始时的提交（Task.baseRef）；找不到时退到和原分支的分叉点 */
  baseRef: string
  baseBranch: string
  /** 状态和快照存这里 */
  stateDir: string
}

type Out = { ok: boolean; reason: string; files: string[] }
const fail = (reason: string, files: string[] = []): Out => ({ ok: false, reason, files })

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const stateFile = (dir: string) => path.join(dir, 'state.json')
const blobFile = (dir: string, h: string) => path.join(dir, `${h}.bin`)

/** 相对路径落在目录里才认（报告里的文件名是 Agent 写的，不能让 ../ 跑到项目外面） */
const inside = (dir: string, file: string) => {
  const p = path.resolve(dir, file)
  const r = path.relative(dir, p)
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? p : ''
}

/** 文件现在的内容（按字节，不动换行和编码）；不存在返回 undefined */
const readNow = (dir: string, file: string): Promise<Buffer | undefined> => {
  const p = inside(dir, file)
  return p ? readFile(p).catch(() => undefined) : Promise.resolve(undefined)
}

const hashOf = (b: Buffer | undefined) => (b ? sha(b) : PATCH_ABSENT)

export async function loadPatch(stateDir: string): Promise<PatchState | undefined> {
  try {
    const s = JSON.parse(await readFile(stateFile(stateDir), 'utf8')) as PatchState
    return s && typeof s.files === 'object' && (s.kind === 'logs' || s.kind === 'fix') ? s : undefined
  } catch {
    return undefined
  }
}

export const appliedOf = (s: PatchState | undefined): PatchStatus['applied'] =>
  s ? { kind: s.kind, at: s.at, files: Object.keys(s.files) } : undefined

const git = (cwd: string, args: string[]) => gitExec(cwd, args, GIT_OPTS)

/** 分支起点：baseRef 是个提交就用它，否则退到和原分支的分叉点；都没有返回空 */
async function baseOf(d: PatchDirs): Promise<string> {
  if (
    d.baseRef &&
    (await git(d.wt, ['cat-file', '-e', `${d.baseRef}^{commit}`]).then(
      () => true,
      () => false,
    ))
  )
    return d.baseRef
  if (!d.baseBranch) return ''
  return git(d.wt, ['merge-base', 'HEAD', d.baseBranch]).then(
    (r) => r.stdout.trim(),
    () => '',
  )
}

/**
 * 独立分支里这几个文件相对分支起点的补丁（含没提交的改动）。没跟踪的新文件 git diff 不带，另和空文件比一次。
 * --relative：项目是仓库的子目录时路径按当前目录写，打补丁那边也在项目目录里跑，两边对得上
 */
async function patchOf(d: PatchDirs, base: string, files: string[]): Promise<string> {
  const tracked = await git(d.wt, [
    'diff',
    '--binary',
    '--no-color',
    '--no-ext-diff',
    '--relative',
    base,
    '--',
    ...files,
  ])
  const others = await git(d.wt, ['ls-files', '--others', '--exclude-standard', '--', ...files])
  let out = tracked.stdout
  for (const f of others.stdout
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)) {
    // 和空文件比有差异时退出码是 1：那是正常结果，输出照用
    const r = await git(d.wt, ['diff', '--binary', '--no-color', '--no-index', '--', '/dev/null', f]).catch(
      (e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }),
    )
    out += r.stdout
  }
  return out
}

/** 把独立分支里这几个文件的改动放到项目目录。ok 为 false 时项目目录没被动过 */
export async function applyPatch(d: PatchDirs, kind: PatchKind, list: string[], now = new Date()): Promise<Out> {
  if (await loadPatch(d.stateDir)) return fail(t('补丁已经在你的工作区里了：先还原，再重新放'))
  const files = [...new Set(list)].filter((f) => inside(d.wt, f) && inside(d.project, f))
  if (!files.length) return fail(t('报告里没有写要放哪些文件'))
  const base = await baseOf(d)
  if (!base) return fail(t('找不到这个对话分支的起点，没法算出它改了什么'))
  let patch: string
  try {
    patch = await patchOf(d, base, files)
  } catch (e) {
    return fail(t('没能从独立分支取出改动：{error}', { error: (e as Error).message.split('\n')[0] }))
  }
  if (!patch.trim()) return fail(t('独立分支里这几个文件没有改动，没有可放的'))
  await mkdir(d.stateDir, { recursive: true })
  const patchFile = path.join(d.stateDir, 'patch.diff')
  await writeFile(patchFile, patch)
  // 先只检查：和工作区现在的内容对不上（你在这些文件里有没提交的改动且撞上了）就一个文件都不动
  const check = await git(d.project, ['apply', '--check', '--whitespace=nowarn', patchFile]).then(
    () => '',
    (e: { stderr?: string; message: string }) => e.stderr || e.message,
  )
  if (check) {
    const lines = applyErrorLines(check)
    const hit = files.filter((f) => lines.some((l) => l.includes(f)))
    return fail(
      [t('和你工作区里这几个文件现在的内容对不上，什么都没动。git 的说明：'), ...lines.map((l) => `- ${l}`)].join('\n'),
      hit,
    )
  }
  // 拍快照：内容按哈希存一份（还原时写回），放完再记每个文件放完那一刻的哈希（还原前核对你有没有再改）
  const before = new Map<string, Buffer | undefined>()
  for (const f of files) {
    const b = await readNow(d.project, f)
    before.set(f, b)
    if (b) await writeFile(blobFile(d.stateDir, sha(b)), b)
  }
  const done = await git(d.project, ['apply', '--whitespace=nowarn', patchFile]).then(
    () => '',
    (e: { stderr?: string; message: string }) => e.stderr || e.message,
  )
  if (done) return fail([t('补丁没能放上去：'), ...applyErrorLines(done).map((l) => `- ${l}`)].join('\n'))
  const state: PatchState = { kind, at: now.toISOString(), files: {} }
  for (const f of files) {
    const b = hashOf(before.get(f))
    const a = hashOf(await readNow(d.project, f))
    // 补丁没碰到的文件不记：还原时不用管它，你之后改它也不算冲突
    if (a !== b) state.files[f] = { before: b, after: a }
  }
  await writeFile(stateFile(d.stateDir), JSON.stringify(state, null, 2))
  return { ok: true, reason: '', files: Object.keys(state.files) }
}

/** 把项目目录里这几个文件写回放之前的样子。ok 为 false 时一个文件都没动 */
export async function restorePatch(d: Pick<PatchDirs, 'project' | 'stateDir'>): Promise<Out> {
  const state = await loadPatch(d.stateDir)
  if (!state) return fail(t('你的工作区里没有面板放的补丁'))
  const names = Object.keys(state.files)
  const now: Record<string, string> = {}
  for (const f of names) now[f] = hashOf(await readNow(d.project, f))
  const changed = restoreConflicts(state, now)
  if (changed.length)
    return fail(
      t(
        '放了之后你又改过这些文件，面板不覆盖你的改动，什么都没动。把你的改动另存或撤掉后再点还原，或者自己删掉那几行 [排查-…] 日志：',
      ),
      changed,
    )
  // 快照先全部读出来：缺一份（数据目录被清过）就不动，免得还原到一半
  const blobs = new Map<string, Buffer>()
  for (const f of names) {
    const h = state.files[f].before
    if (h === PATCH_ABSENT) continue
    const b = await readFile(blobFile(d.stateDir, h)).catch(() => undefined)
    if (!b) return fail(t('放之前的快照找不到了，没法自动还原：请自己把这些文件改回去'), names)
    blobs.set(f, b)
  }
  for (const f of names) {
    const p = inside(d.project, f)
    if (!p) continue
    const b = blobs.get(f)
    if (b) await writeFile(p, b)
    else await rm(p, { force: true })
  }
  // 写完再读一遍核对：和快照不一致的列出来（磁盘满、文件被别的程序占着），状态留着方便再试
  const left = []
  for (const f of names) if (hashOf(await readNow(d.project, f)) !== state.files[f].before) left.push(f)
  if (left.length) return fail(t('这些文件写回后和快照不一致，请手工检查：'), left)
  await rm(d.stateDir, { recursive: true, force: true })
  return { ok: true, reason: '', files: names }
}

/** 用户选了自己处理：面板不再记这份补丁（不动任何文件） */
export async function forgetPatch(stateDir: string) {
  await rm(stateDir, { recursive: true, force: true })
}
