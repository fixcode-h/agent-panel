/**
 * 盯一整棵目录树的改动（ADR 0074）：表格枚举扫描、UE 的 Lua GM 扫描、文件索引都用这一份。
 * Windows / macOS：根目录一个递归监听（一个句柄盯整棵树）；Linux：逐个目录盯（Node 在 Linux 上的递归监听按文件盯，
 * 文件被「写临时文件再改名替换」后就盯丢了，2026-11-14 表格枚举扫描实测），新建的子目录在 rename 事件里补上，最多 maxDirs 个。
 * 底下的目录监听和别的订阅者共用（dir.ts）
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { watchDir, type DirWatch } from './dir.ts'

/** Linux 上一棵树最多盯这么多个目录（每个目录一个 inotify 句柄） */
export const MAX_TREE_DIRS = 2000

/** 默认跳过的目录：版本管理、依赖、UE 的生成物 */
// 模块状态：运行时，只读的默认跳过表，谁都不改
export const TREE_SKIP: ReadonlySet<string> = new Set([
  '.git',
  '.svn',
  '.p4',
  'node_modules',
  'Intermediate',
  'Binaries',
  'Saved',
  'DerivedDataCache',
])

export interface TreeOpts {
  /** 跳过这个子目录（名字，不是路径）；默认 TREE_SKIP 和点开头的目录 */
  skipDir?: (name: string) => boolean
  /** 监听出错（缓冲溢出、根目录被删）：调用方做一次整体核对 */
  onLost?: (why: string) => void
  /** 只用递归监听（Windows / macOS）；Linux 上不盯（文件索引的「自动」） */
  recursiveOnly?: boolean
  maxDirs?: number
  platform?: NodeJS.Platform
}

export interface TreeWatch {
  close(): void
}

const defaultSkip = (name: string) => TREE_SKIP.has(name) || name.startsWith('.')

/** rel：相对根的路径（/ 分隔）；系统没给文件名时是 null */
export function watchTree(root: string, on: (rel: string | null) => void, o: TreeOpts = {}): TreeWatch | undefined {
  const platform = o.platform ?? process.platform
  const skip = o.skipDir ?? defaultSkip
  const slash = (p: string) => p.replace(/\\/g, '/')
  if (platform === 'win32' || platform === 'darwin') {
    const w = watchDir(root, (name) => on(name === null ? null : slash(name)), { recursive: true, onLost: o.onLost })
    return w
  }
  if (o.recursiveOnly) return undefined
  const max = o.maxDirs ?? MAX_TREE_DIRS
  const dirs = new Map<string, DirWatch>()
  let closed = false
  const add = (dir: string) => {
    if (closed || dirs.has(dir) || dirs.size >= max) return
    const w = watchDir(dir, (name) => {
      const rel = slash(path.relative(root, name ? path.join(dir, name) : dir))
      // 新建 / 改名进来的子目录也要盯上
      if (name && !skip(path.basename(name))) void walk(path.join(dir, name))
      on(name ? rel : null)
    })
    if (w) dirs.set(dir, w)
  }
  const walk = async (dir: string) => {
    const list = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!list || closed) return
    add(dir)
    for (const e of list) if (e.isDirectory() && !skip(e.name)) await walk(path.join(dir, e.name))
  }
  void walk(root)
  return {
    close: () => {
      closed = true
      for (const w of dirs.values()) w.close()
      dirs.clear()
    },
  }
}
