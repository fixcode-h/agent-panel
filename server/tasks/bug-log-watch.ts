/**
 * 面板自己取日志（分析稿 B3，纯逻辑在 shared/bug-log-watch.ts）：
 * 「开始复现」记下报告里写的那个日志文件现在多大，「复现完了，取日志」读新增的那一段。
 * 读哪个文件不由页面说：路径从报告的「日志在哪」里认，页面只带一个「我确认读项目外面的这个文件」。
 * 只读项目目录、对话目录下的文件；报告里明确写了绝对路径且用户点了确认的也读；其余一律拒绝并说明
 */
import { open, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import {
  isAbsPath,
  logPathIn,
  looksUtf16,
  newRange,
  relatedLines,
  tidyLog,
  type LogFetchResult,
  type LogRefuse,
  type LogStartResult,
} from '../../shared/bug-log-watch.ts'

/** 记下的起点：abs 是当时认定的文件，size 是那一刻的大小（字节） */
export type WatchMark = { path: string; abs: string; size: number; at: string }

export interface WatchDirs {
  /** 用户的项目目录 */
  project: string
  /** 对话改文件的目录（独立分支在用就是它，否则和项目目录一样） */
  work: string
  /** 起点存这里（对话数据目录下） */
  stateDir: string
}

export type Resolved = { ok: true; path: string; abs: string; outside: boolean } | LogRefuse

const within = (dir: string, p: string) => {
  if (!dir) return false
  const r = path.relative(dir, p)
  return !r.startsWith('..') && !path.isAbsolute(r)
}

/** 链接解开后的真实路径；文件还不存在时解它所在的目录（目录也没有就原样返回） */
async function real(p: string): Promise<string> {
  const direct = await realpath(p).catch(() => '')
  if (direct) return direct
  const up = await realpath(path.dirname(p)).catch(() => '')
  return up ? path.join(up, path.basename(p)) : p
}

/**
 * 报告里写的日志文件到底是哪个、能不能读。
 * - 相对路径：先按项目目录找（用户在那里复现），没有再按对话目录；都没有就按项目目录算（复现时才生成的日志）；
 * - 绝对路径在两个目录里：直接读；在外面：报告里写的就是这个路径、用户又点了确认才读；
 * - 解开符号链接后跑到目录外面的按「在外面」算，不能靠链接绕过去
 */
export async function resolveLogPath(where: string | undefined, d: WatchDirs, confirm: boolean): Promise<Resolved> {
  const shown = logPathIn(where)
  if (!shown) return { ok: false, error: t('报告里没有写日志文件的位置，请自己把日志贴进来') }
  const roots = [...new Set([d.project, d.work].filter(Boolean))]
  let abs = ''
  if (isAbsPath(shown)) abs = path.resolve(shown)
  else {
    const tries = roots.map((r) => path.resolve(r, shown)).filter((p, i) => within(roots[i], p))
    if (!tries.length) return { ok: false, path: shown, error: t('{path} 不在项目目录里，面板不读', { path: shown }) }
    for (const p of tries) if (!abs && (await stat(p).catch(() => null))) abs = p
    abs ||= tries[0]
  }
  const actual = await real(abs)
  const realRoots = await Promise.all(roots.map(real))
  const outside = !realRoots.some((r) => within(r, actual))
  if (!outside) return { ok: true, path: shown, abs: actual, outside: false }
  // 走到这里只可能是报告里写的绝对路径，或者相对路径被符号链接带到了外面：后一种不读
  if (!isAbsPath(shown))
    return { ok: false, path: shown, error: t('{path} 指向项目目录外面的文件，面板不读', { path: shown }) }
  if (!confirm)
    return {
      ok: false,
      path: shown,
      needConfirm: true,
      error: t('{path} 在项目目录和对话目录外面：这是报告里写的日志位置，你确认后面板才读它', { path: shown }),
    }
  return { ok: true, path: shown, abs: actual, outside: true }
}

const markFile = (dir: string) => path.join(dir, 'log-watch.json')

export async function loadMark(stateDir: string): Promise<WatchMark | undefined> {
  try {
    const m = JSON.parse(await readFile(markFile(stateDir), 'utf8')) as WatchMark
    return m && typeof m.abs === 'string' && typeof m.size === 'number' ? m : undefined
  } catch {
    return undefined
  }
}

/** 开始复现：记下文件现在多大。文件还没有（复现时才生成）从 0 记，取的时候整个文件都算新增 */
export async function startWatch(
  where: string | undefined,
  d: WatchDirs,
  confirm: boolean,
  now = new Date(),
): Promise<LogStartResult> {
  const r = await resolveLogPath(where, d, confirm)
  if (!r.ok) return r
  const st = await stat(r.abs).catch(() => null)
  if (st && !st.isFile()) return { ok: false, path: r.path, error: t('{path} 不是文件', { path: r.path }) }
  const mark: WatchMark = { path: r.path, abs: r.abs, size: st?.size ?? 0, at: now.toISOString() }
  await mkdir(d.stateDir, { recursive: true })
  await writeFile(markFile(d.stateDir), JSON.stringify(mark))
  return { ok: true, path: r.path, size: mark.size, missing: !st, outside: r.outside }
}

/**
 * 复现完了：读从起点到现在新增的那一段。路径和能不能读都重新认一遍（期间文件被换成链接也按现在的算）；
 * 报告里写的位置和开始时不一样了（交了新一版）就要求重新开始
 */
export async function fetchWatch(where: string | undefined, d: WatchDirs, confirm: boolean): Promise<LogFetchResult> {
  const mark = await loadMark(d.stateDir)
  if (!mark) return { ok: false, error: t('还没有点「开始复现」：面板不知道从哪里开始算新增的日志') }
  const r = await resolveLogPath(where, d, confirm)
  if (!r.ok) return r
  if (r.path !== mark.path)
    return { ok: false, path: r.path, error: t('日志文件的位置和开始复现时不一样了，请重新点「开始复现」') }
  const st = await stat(r.abs).catch(() => null)
  if (!st?.isFile())
    return {
      ok: false,
      path: r.path,
      error: t('找不到日志文件 {path}：确认复现时确实写了日志，或者自己把日志贴进来', { path: r.path }),
    }
  const range = newRange(mark.size, st.size)
  const buf = Buffer.alloc(range.length)
  if (range.length) {
    const fh = await open(r.abs, 'r')
    try {
      await fh.read(buf, 0, range.length, range.from)
    } finally {
      await fh.close()
    }
  }
  const text = tidyLog(buf.toString(looksUtf16(buf) ? 'utf16le' : 'utf8'), range.truncated)
  return {
    ok: true,
    path: r.path,
    text,
    related: relatedLines(text),
    bytes: range.total,
    truncated: range.truncated,
    rotated: range.rotated,
  }
}
