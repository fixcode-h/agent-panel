/**
 * 表格页里直接做的版本操作：看这个文件的状态（改没改、有没有冲突）、提交这一个文件、
 * 冲突时取三方（共同祖先 / 我这边 / 对方）的内容给页面合并、合完标记解决。
 * Git、P4、SVN 各走各的命令，界面只看统一的结果。合并本身在页面上做（shared/table-merge.ts），
 * 写文件走保存那条会验证的路，这里不直接改表格内容
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import type { SheetData } from '../../shared/files.ts'
import { detectVcs } from '../projects-analyze.ts'
import { parseZtag } from '../p4-split.ts'
import { forgetLists, forgetTable, parseTableBuffer } from './files.ts'
import { HttpError } from './http-error.ts'
import { vcsRun } from './history.ts'

export interface VcsStatus {
  vcs: 'git' | 'p4' | 'svn' | 'none'
  /** 本地有没提交的改动（含新文件） */
  changed: boolean
  /** 有没解决的冲突：可以用三方合并 */
  conflict: boolean
  error?: string
}

const text = (b: Buffer) => b.toString('utf8')
const p4File = (cwd: string, rel: string) => path.join(cwd, rel)

async function p4Fstat(cwd: string, rel: string) {
  const out = text(await vcsRun('p4', ['-ztag', 'fstat', '-Or', p4File(cwd, rel)], cwd).catch(() => Buffer.from('')))
  return parseZtag(out)[0] ?? {}
}

export async function vcsStatus(cwd: string, rel: string): Promise<VcsStatus> {
  const { vcs } = await detectVcs(cwd)
  if (vcs === 'none') return { vcs, changed: false, conflict: false }
  try {
    if (vcs === 'git') {
      const st = text(await vcsRun('git', ['status', '--porcelain=v1', '--', rel], cwd)).split('\n')[0] ?? ''
      const xy = st.slice(0, 2)
      return { vcs, changed: !!st.trim(), conflict: /U|AA|DD/.test(xy) }
    }
    if (vcs === 'p4') {
      const f = await p4Fstat(cwd, rel)
      // 没签出也可能改过（可写的工作区）：diff -se 列出没打开但内容变了的文件
      const diff = f.action
        ? ''
        : text(await vcsRun('p4', ['diff', '-se', p4File(cwd, rel)], cwd).catch(() => Buffer.from(''))).trim()
      return { vcs, changed: !!f.action || !!diff, conflict: f.unresolved !== undefined || !!f.resolveAction0 }
    }
    const st = text(await vcsRun('svn', ['status', `./${rel}`], cwd)).split('\n')[0] ?? ''
    return { vcs, changed: /^[MA?R!C]/.test(st), conflict: st[0] === 'C' }
  } catch (e) {
    return { vcs, changed: false, conflict: false, error: (e as Error).message }
  }
}

/** 只提交这一个文件：git commit（只提交到本地仓库，不推送）/ p4 submit / svn commit */
export async function submitTable(cwd: string, rel: string, message: string): Promise<{ vcs: string; out: string }> {
  const msg = message.trim()
  if (!msg) throw new HttpError(t('写一句提交说明'))
  const st = await vcsStatus(cwd, rel)
  if (st.vcs === 'none') throw new HttpError(t('这个文件不在版本管理里'))
  if (st.error) throw new HttpError(st.error)
  if (st.conflict) throw new HttpError(t('这个文件还有冲突没解决，先合并再提交'))
  if (!st.changed) throw new HttpError(t('这个文件没有改动，不用提交'))
  try {
    if (st.vcs === 'git') {
      await vcsRun('git', ['add', '--', rel], cwd)
      // 带路径的 commit 只提交这个文件，暂存区里别的文件不受影响
      return { vcs: 'git', out: text(await vcsRun('git', ['commit', '-m', msg, '--', rel], cwd)).trim() }
    }
    if (st.vcs === 'p4') {
      const full = p4File(cwd, rel)
      if (!(await p4Fstat(cwd, rel)).action) await vcsRun('p4', ['reconcile', '-e', '-a', full], cwd)
      return { vcs: 'p4', out: text(await vcsRun('p4', ['submit', '-d', msg, full], cwd)).trim() }
    }
    const s = text(await vcsRun('svn', ['status', `./${rel}`], cwd))
    if (s.startsWith('?')) await vcsRun('svn', ['add', `./${rel}`], cwd)
    return { vcs: 'svn', out: text(await vcsRun('svn', ['commit', '-m', msg, `./${rel}`], cwd)).trim() }
  } catch (e) {
    throw new HttpError((e as Error).message, 409)
  }
}

export interface MergeSources {
  vcs: string
  base: SheetData[]
  theirs: SheetData[]
  /** 对方是哪一版（显示用） */
  theirsLabel: string
  /** 工作区里的文件被换成了「我这边」的干净内容（文本表格冲突时里面是冲突标记）：页面要重新载入 */
  replaced: boolean
}

/**
 * 让工作区里的文件是「我这边」的干净内容：Git / SVN 合并文本文件（CSV）时会往里写冲突标记，
 * 合并要在干净的「我这边」上做。二进制的 xlsx 本来就是我这边，不动。换之前先 backup()
 */
async function ensureOurs(full: string, ours: Buffer | null, backup: () => Promise<void>) {
  if (!ours) return false
  const cur = await readFile(full).catch(() => null)
  if (cur && cur.equals(ours)) return false
  await backup()
  const tmp = `${full}.${process.pid}.agentpanel-tmp`
  try {
    await writeFile(tmp, ours)
    await rename(tmp, full)
  } catch (e) {
    await rm(tmp, { force: true })
    throw new HttpError(t('写入失败：{err}', { err: (e as Error).message }), 409)
  }
  forgetTable(full)
  forgetLists()
  return true
}

const parse = async (rel: string, b: Buffer | null) => (b ? (await parseTableBuffer(rel, b)).sheets : [])
const tryRun = (cmd: Parameters<typeof vcsRun>[0], args: string[], cwd: string) =>
  vcsRun(cmd, args, cwd).catch(() => null)
const unxml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

/** 冲突时的共同祖先和对方的内容；我这边就是工作区里的文件（先换成干净的我这边，见 ensureOurs） */
export async function mergeSources(cwd: string, rel: string, backup: () => Promise<void>): Promise<MergeSources> {
  const st = await vcsStatus(cwd, rel)
  if (st.error) throw new HttpError(st.error)
  if (!st.conflict) throw new HttpError(t('这个文件没有冲突'))
  if (st.vcs === 'git') {
    // 冲突时暂存区里有三份：:1 共同祖先、:2 我这边、:3 对方（两边都新加的文件没有 :1）
    const base = await tryRun('git', ['show', `:1:./${rel}`], cwd)
    const theirs = await tryRun('git', ['show', `:3:./${rel}`], cwd)
    if (!theirs) throw new HttpError(t('取不到对方的版本（对方删了这个文件？）'))
    const head = text((await tryRun('git', ['rev-parse', '--short', 'MERGE_HEAD'], cwd)) ?? Buffer.from('')).trim()
    const replaced = await ensureOurs(path.join(cwd, rel), await tryRun('git', ['show', `:2:./${rel}`], cwd), backup)
    return {
      vcs: 'git',
      base: await parse(rel, base),
      theirs: await parse(rel, theirs),
      theirsLabel: head || ':3',
      replaced,
    }
  }
  if (st.vcs === 'p4') {
    const f = await p4Fstat(cwd, rel)
    const from = f.resolveFromFile0
    if (!from) throw new HttpError(t('P4 没给出要合并的版本（p4 fstat -Or 里没有 resolveFromFile）'))
    const theirsRev = `${from}#${f.resolveEndFromRev0}`
    const baseRev = f.resolveBaseFile0 ? `${f.resolveBaseFile0}#${f.resolveBaseRev0}` : ''
    const theirs = await vcsRun('p4', ['print', '-q', theirsRev], cwd)
    const base = baseRev ? await tryRun('p4', ['print', '-q', baseRev], cwd) : null
    return {
      vcs: 'p4',
      base: await parse(rel, base),
      theirs: await parse(rel, theirs),
      theirsLabel: theirsRev,
      replaced: false,
    }
  }
  // SVN：冲突时旁边留着 .rOLD（共同祖先）、.rNEW（对方），svn info 里写着文件名
  const xml = text(await vcsRun('svn', ['info', '--xml', `./${rel}`], cwd))
  const tag = (n: string) => {
    const v = new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(xml)?.[1]
    return v ? unxml(v.trim()) : ''
  }
  const fileOf = (n: string) => (n ? (path.isAbsolute(n) ? n : path.join(cwd, path.dirname(rel), n)) : '')
  const baseFile = fileOf(tag('prev-base-file'))
  const theirsFile = fileOf(tag('cur-base-file'))
  if (!theirsFile) throw new HttpError(t('SVN 没给出对方版本的文件（svn info 里没有 cur-base-file）'))
  const base = baseFile ? await readFile(baseFile).catch(() => null) : null
  const mine = fileOf(tag('prev-wc-file'))
  const replaced = mine ? await ensureOurs(path.join(cwd, rel), await readFile(mine).catch(() => null), backup) : false
  return {
    replaced,
    vcs: 'svn',
    base: await parse(rel, base),
    theirs: await parse(rel, await readFile(theirsFile)),
    theirsLabel: path.basename(theirsFile),
  }
}

/** 合并后保存好了：告诉版本管理这个冲突解决了（以工作区里的文件为准） */
export async function markResolved(cwd: string, rel: string): Promise<VcsStatus> {
  const { vcs } = await detectVcs(cwd)
  try {
    if (vcs === 'git') await vcsRun('git', ['add', '--', rel], cwd)
    else if (vcs === 'p4') await vcsRun('p4', ['resolve', '-ay', p4File(cwd, rel)], cwd)
    else if (vcs === 'svn') await vcsRun('svn', ['resolve', '--accept', 'working', `./${rel}`], cwd)
    else throw new HttpError(t('这个文件不在版本管理里'))
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError((e as Error).message, 409)
  }
  return vcsStatus(cwd, rel)
}
