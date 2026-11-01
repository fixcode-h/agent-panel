import { access, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DirInfo, DirListing } from '../shared/schema.ts'
import { t } from '../shared/i18n.ts'

/** 支持 ~ 开头的路径 */
export function resolvePath(p: string) {
  const t = p.trim()
  if (!t) return os.homedir()
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) return path.join(os.homedir(), t.slice(1))
  return path.resolve(t)
}

async function gitBranch(dir: string): Promise<string | null> {
  try {
    const head = (await readFile(path.join(dir, '.git', 'HEAD'), 'utf8')).trim()
    return head.startsWith('ref: ') ? head.replace(/^ref: refs\/heads\//, '') : head.slice(0, 7)
  } catch {
    return null
  }
}

/** 初始化写的 AGENTS.md 一定带文档地图（指向 DOC_ROOT/MODULE-MAP.md），手写的一般没有 */
async function initialized(dir: string) {
  try {
    return (await readFile(path.join(dir, 'AGENTS.md'), 'utf8')).includes('MODULE-MAP')
  } catch {
    return false
  }
}

export async function inspectDir(p: string): Promise<DirInfo> {
  const full = resolvePath(p)
  try {
    const s = await stat(full)
    const isDir = s.isDirectory()
    return {
      path: full,
      exists: true,
      isDir,
      gitBranch: isDir ? await gitBranch(full) : null,
      initialized: isDir && (await initialized(full)),
    }
  } catch {
    return { path: full, exists: false, isDir: false, gitBranch: null, initialized: false }
  }
}

/** 列出子目录（隐藏目录除外），供前端的目录浏览器使用 */
export async function listDir(p: string): Promise<DirListing> {
  const full = resolvePath(p)
  const entries = await readdir(full, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(full, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const parent = path.dirname(full)
  return { path: full, parent: parent === full ? null : parent, dirs, roots: await roots() }
}

let driveCache: { at: number; list: { name: string; path: string }[] } | null = null

/** Windows 上逐个试 A: 到 Z:，没有现成的接口能列盘符；结果缓存 10 秒，插拔 U 盘后很快能看到 */
async function roots() {
  const home = { name: t('主目录'), path: os.homedir() }
  if (process.platform !== 'win32') return [home, { name: '/', path: '/' }]
  if (!driveCache || Date.now() - driveCache.at > 10_000) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const found = await Promise.all(
      letters.map((l) =>
        access(`${l}:\\`)
          .then(() => ({ name: `${l}:`, path: `${l}:\\` }))
          .catch(() => null),
      ),
    )
    driveCache = { at: Date.now(), list: found.filter((x) => x !== null) }
  }
  return [home, ...driveCache.list]
}

/** 在 parent 下新建一个文件夹，返回它的完整路径；名字不能带路径分隔符和 Windows 不允许的字符 */
export async function makeDir(parent: string, name: string) {
  const n = name.trim()
  if (!n) throw new Error(t('请输入文件夹名'))
  // oxlint-disable-next-line no-control-regex -- 故意匹配控制字符（ANSI 转义序列、不可见字符）
  if (n === '.' || n === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(n) || /[. ]$/.test(n))
    throw new Error(t('文件夹名不能包含 \\ / : * ? " < > |，也不能以点或空格结尾'))
  const dir = resolvePath(parent)
  const full = path.join(dir, n)
  if (
    await stat(full)
      .then(() => true)
      .catch(() => false)
  )
    throw new Error(t('「{name}」已经存在', { name: n }))
  // 不递归：父目录必须已经存在，避免路径写错时悄悄建出一串目录
  await mkdir(full)
  return full
}
