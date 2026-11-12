/**
 * 表格的版本记录：Git log / P4 filelog / SVN log 列出这个文件的历次提交，
 * 取某一版的文件内容（git show / p4 print / svn cat）按同一套解析器读成工作表，交给页面做格子级差异。
 * 这里只读；把本地文件换成某一版的内容见 checkout.ts。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import type { SheetData } from '../../shared/files.ts'
import { childEnv } from '../exec/process.ts'
import { gitArgs } from '../exec/git.ts'
import { detectVcs } from '../projects-analyze.ts'
import { parseZtag } from '../p4-split.ts'
import { parseTableBuffer } from './files.ts'
import { HttpError } from './http-error.ts'

export interface TableRev {
  /** 取内容时传回来的版本号：git 的提交、p4 的 #rev、svn 的修订号 */
  id: string
  /** 界面上显示的短号：提交前 8 位、#58213（changelist）、r1234 */
  label: string
  author: string
  time: string
  message: string
}

export interface TableHistory {
  vcs: 'git' | 'p4' | 'svn' | 'none'
  /** 本地改动对比的基准版本（git HEAD、p4 #have、svn BASE）；没有版本控制时为空 */
  base: string
  revs: TableRev[]
  /** 版本控制命令出错的原因（没装、没登录……）：如实显示 */
  error?: string
}

const MAX_REVS = 40
/** 旧版本的文件最大读这么多（和打开文件的上限一致） */
const MAX_BYTES = 64 * 1024 * 1024

/** 三种版本控制共用：git 的参数照 server/exec/git.ts 的 gitArgs 补上（中文路径不转义），其余原样 */
export function vcsRun(cmd: 'git' | 'p4' | 'svn', args: string[], cwd: string) {
  return new Promise<Buffer>((resolve, reject) =>
    execFile(
      cmd,
      cmd === 'git' ? gitArgs(args) : args,
      {
        cwd,
        env: { ...childEnv([]), PWD: cwd },
        encoding: 'buffer',
        maxBuffer: MAX_BYTES,
        timeout: 60_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const why =
            Buffer.from(stderr ?? '')
              .toString('utf8')
              .trim() || err.message
          return reject(new Error(`${cmd} ${args[0]}：${why}`))
        }
        resolve(stdout)
      },
    ),
  )
}

const text = (b: Buffer) => b.toString('utf8')

export async function tableHistory(dir: string, rel: string): Promise<TableHistory> {
  const { vcs } = await detectVcs(dir)
  if (vcs === 'none') return { vcs, base: '', revs: [] }
  try {
    if (vcs === 'git') {
      const out = text(
        await vcsRun(
          'git',
          ['log', `-n${MAX_REVS}`, '--follow', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '--', rel],
          dir,
        ),
      )
      const revs = out
        .split('\x1e')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [id, author, time, message] = l.split('\x1f')
          return { id, label: id.slice(0, 8), author, time, message }
        })
      return { vcs, base: 'HEAD', revs }
    }
    if (vcs === 'p4') {
      const out = text(await vcsRun('p4', ['-ztag', 'filelog', '-m', String(MAX_REVS), '-l', path.join(dir, rel)], dir))
      const rec = parseZtag(out)[0] ?? {}
      const revs: TableRev[] = []
      for (let i = 0; rec[`rev${i}`] !== undefined; i++)
        revs.push({
          id: `#${rec[`rev${i}`]}`,
          label: `#${rec[`change${i}`] ?? rec[`rev${i}`]}`,
          author: rec[`user${i}`] ?? '',
          time: rec[`time${i}`] ? new Date(Number(rec[`time${i}`]) * 1000).toISOString() : '',
          message: (rec[`desc${i}`] ?? '').trim(),
        })
      return { vcs, base: '#have', revs }
    }
    const xml = text(await vcsRun('svn', ['log', '--xml', '-l', String(MAX_REVS), `./${rel}`], dir))
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

/** 取过的旧版本内容：提交过的版本不会再变，按「目录 + 路径 + 版本」留着（HEAD / #have / BASE 会变，不留） */
const atCache = new Map<string, SheetData[]>()
const AT_CACHE = 24
const MOVING = /^(HEAD|#have|BASE)$/

/** 某一版的内容：不在那一版里（新加的文件）时返回空表 */
export async function tableAt(dir: string, rel: string, rev: string): Promise<SheetData[]> {
  const key = `${dir}\n${rel}\n${rev}`
  const hit = atCache.get(key)
  if (hit) return hit
  const sheets = await readAt(dir, rel, rev)
  if (!MOVING.test(rev)) {
    atCache.set(key, sheets)
    if (atCache.size > AT_CACHE) atCache.delete(atCache.keys().next().value!)
  }
  return sheets
}

async function readAt(dir: string, rel: string, rev: string): Promise<SheetData[]> {
  const buf = await rawAt(dir, rel, rev)
  return buf ? (await parseTableBuffer(rel, buf)).sheets : []
}

/** 某一版文件的原始字节（git show / p4 print / svn cat）；那一版里还没有这个文件时返回 null */
export async function rawAt(dir: string, rel: string, rev: string): Promise<Buffer | null> {
  if (!/^[\w#^~@][\w#.^~:@/-]{0,79}$/.test(rev)) throw new HttpError(t('版本号格式不对'))
  const { vcs } = await detectVcs(dir)
  try {
    if (vcs === 'git') return await vcsRun('git', ['show', `${rev}:./${rel}`], dir)
    if (vcs === 'p4') return await vcsRun('p4', ['print', '-q', `${path.join(dir, rel)}${rev}`], dir)
    if (vcs === 'svn') return await vcsRun('svn', ['cat', '-r', rev, `./${rel}`], dir)
    throw new HttpError(t('这个项目没有版本控制'))
  } catch (e) {
    if (e instanceof HttpError) throw e
    const msg = (e as Error).message
    // 那一版里还没有这个文件：当成空表，差异里整张都是新增
    if (
      /does not exist|exists on disk, but not in|no such file|not in the depot|path not found|unknown revision/i.test(
        msg,
      )
    )
      return null
    throw new HttpError(msg)
  }
}
