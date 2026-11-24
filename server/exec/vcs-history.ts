/**
 * 一个文件的版本记录（git log / p4 filelog / svn log）和取某一版的原始字节（git show / p4 print / svn cat）。
 * 表格的版本差异、UE 资源的版本差异都用这一份（开放模块）；把本地文件换成某一版、提交这些写操作在各自插件里。
 * .uasset 这类二进制在 git 里多半走 LFS：git show 拿到的是指针文件，这里经 git lfs smudge 换回真正的内容。
 */
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import { childEnv } from './process.ts'
import { vcsRun } from './vcs-run.ts'
import { VCS_MAX_BYTES } from '../vcs/run.ts'
import { gitRaw } from './git.ts'
import { detectVcs } from '../vcs/detect.ts'
import { parseZtag } from '../p4-split.ts'

export interface FileRev {
  /** 取内容时传回来的版本号：git 的提交、p4 的 #rev、svn 的修订号 */
  id: string
  /** 界面上显示的短号：提交前 8 位、#58213（changelist）、r1234 */
  label: string
  author: string
  time: string
  message: string
  /** 这一版所在的提交：git 是提交号（同 id），p4 是变更列表号（id 是文件的 #rev）；查「同一次提交还改了哪些文件」用 */
  change?: string
}

export interface FileHistory {
  vcs: 'git' | 'p4' | 'svn' | 'none'
  /** 本地改动对比的基准版本（git HEAD、p4 #have、svn BASE）；没有版本控制时为空 */
  base: string
  revs: FileRev[]
  /** 版本控制命令出错的原因（没装、没登录……）：如实显示 */
  error?: string
}

/** 版本号不合法、或者项目没有版本控制：调用方按「请求有误」处理（表格插件转成 400） */
export class VcsInputError extends Error {}

const DEFAULT_REVS = 40

/** git 跑一条命令，形状和 vcsRun 一样（原始字节、失败抛错带 git 的说明）；经 server/exec/git.ts 起，中文路径不转义 */
export async function gitVcs(args: string[], cwd: string, input?: Buffer): Promise<Buffer> {
  const r = await gitRaw(cwd, args, {
    env: { ...childEnv([]), PWD: cwd },
    maxBuffer: VCS_MAX_BYTES,
    timeoutMs: 60_000,
    input,
  })
  if (r.code !== 0)
    throw new Error(`git ${args[0]}：${r.stderr.trim() || t('退出码 {code}', { code: String(r.code) })}`)
  return r.stdout
}

const text = (b: Buffer) => b.toString('utf8')

export async function fileHistory(dir: string, rel: string, max = DEFAULT_REVS): Promise<FileHistory> {
  const { vcs } = await detectVcs(dir)
  if (vcs === 'none') return { vcs, base: '', revs: [] }
  try {
    if (vcs === 'git') {
      const out = text(
        await gitVcs(['log', `-n${max}`, '--follow', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '--', rel], dir),
      )
      const revs = out
        .split('\x1e')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [id, author, time, message] = l.split('\x1f')
          return { id, label: id.slice(0, 8), author, time, message, change: id }
        })
      return { vcs, base: 'HEAD', revs }
    }
    if (vcs === 'p4') {
      const out = text(await vcsRun('p4', ['-ztag', 'filelog', '-m', String(max), '-l', path.join(dir, rel)], dir))
      const rec = parseZtag(out)[0] ?? {}
      const revs: FileRev[] = []
      for (let i = 0; rec[`rev${i}`] !== undefined; i++)
        revs.push({
          id: `#${rec[`rev${i}`]}`,
          label: `#${rec[`change${i}`] ?? rec[`rev${i}`]}`,
          author: rec[`user${i}`] ?? '',
          time: rec[`time${i}`] ? new Date(Number(rec[`time${i}`]) * 1000).toISOString() : '',
          message: (rec[`desc${i}`] ?? '').trim(),
          ...(rec[`change${i}`] ? { change: rec[`change${i}`] } : {}),
        })
      return { vcs, base: '#have', revs }
    }
    const xml = text(await vcsRun('svn', ['log', '--xml', '-l', String(max), `./${rel}`], dir))
    const revs = [...xml.matchAll(/<logentry\s+revision="(\d+)">([\s\S]*?)<\/logentry>/g)].map((m) => {
      const tag = (n: string) => unxml(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(m[2])?.[1] ?? '')
      return { id: m[1], label: `r${m[1]}`, author: tag('author'), time: tag('date'), message: tag('msg').trim() }
    })
    return { vcs, base: 'BASE', revs }
  } catch (e) {
    return { vcs, base: '', revs: [], error: (e as Error).message }
  }
}

const unxml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** HEAD / #have / BASE 会随同步变化，取出来的内容不能按版本号缓存；其他版本号提交过就不会再变 */
export const MOVING_REV = /^(HEAD|#have|BASE)$/

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1'

/** git 里存的是 LFS 指针时换成真正的内容（本机 LFS 缓存里没有时 git lfs 会去下载） */
async function lfsSmudge(dir: string, rel: string, buf: Buffer): Promise<Buffer> {
  if (buf.length > 1024 || !text(buf.subarray(0, LFS_POINTER.length)).startsWith(LFS_POINTER)) return buf
  return gitVcs(['lfs', 'smudge', '--', rel], dir, buf)
}

/** 某一版文件的原始字节；那一版里还没有这个文件时返回 null。版本号不合法、没有版本控制时抛 VcsInputError */
export async function fileAt(dir: string, rel: string, rev: string): Promise<Buffer | null> {
  if (!/^[\w#^~@][\w#.^~:@/-]{0,79}$/.test(rev)) throw new VcsInputError(t('版本号格式不对'))
  const { vcs } = await detectVcs(dir)
  try {
    if (vcs === 'git') return await lfsSmudge(dir, rel, await gitVcs(['show', `${rev}:./${rel}`], dir))
    if (vcs === 'p4') return await vcsRun('p4', ['print', '-q', `${path.join(dir, rel)}${rev}`], dir)
    if (vcs === 'svn') return await vcsRun('svn', ['cat', '-r', rev, `./${rel}`], dir)
  } catch (e) {
    const msg = (e as Error).message
    // 那一版里还没有这个文件：调用方当成新建
    if (
      /does not exist|exists on disk, but not in|no such file|not in the depot|path not found|unknown revision/i.test(
        msg,
      )
    )
      return null
    throw e
  }
  throw new VcsInputError(t('这个项目没有版本控制'))
}

const CHANGED_MAX = 500

/**
 * 一次提交（git 提交号 / p4 变更列表号）里改了的文件，路径相对 dir，只列 dir 下面的（UE 资源版本差异的「同一次提交里一起改的资源」用）。
 * p4 的 describe 给的是仓库路径：先问一次 dir 在仓库里对应哪里（p4 where），再换成相对路径。svn 暂不支持，返回空
 */
export async function changedFiles(dir: string, change: string): Promise<string[]> {
  if (!/^[\w.^~@-]{1,80}$/.test(change)) throw new VcsInputError(t('版本号格式不对'))
  const { vcs } = await detectVcs(dir)
  if (vcs === 'git') {
    const out = text(await gitVcs(['show', '--name-only', '--relative', '--format=', change, '--'], dir))
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, CHANGED_MAX)
  }
  if (vcs === 'p4') {
    const where = parseZtag(text(await vcsRun('p4', ['-ztag', 'where', path.join(dir, '...')], dir)))[0] ?? {}
    const depotRoot = String(where.depotFile ?? '').replace(/\/\.\.\.$/, '/')
    const rec = parseZtag(text(await vcsRun('p4', ['-ztag', 'describe', '-s', change], dir)))[0] ?? {}
    const out: string[] = []
    for (let i = 0; rec[`depotFile${i}`] !== undefined && out.length < CHANGED_MAX; i++) {
      const f = rec[`depotFile${i}`]
      if (depotRoot && f.toLowerCase().startsWith(depotRoot.toLowerCase())) out.push(f.slice(depotRoot.length))
    }
    return out
  }
  return []
}
