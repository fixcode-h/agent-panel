/**
 * 读磁盘：一层（readLevel）和整棵（buildTree）。只 readdir，不读文件内容、不 stat 文件；
 * 符号链接和 junction 一律不跟（跟出去会进项目外、绕回来成环，和 server/files.ts 的 walk 一致）
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { skipDir, type SkipRule } from '../../shared/file-index/rules.ts'
import type { NameTable, TableDelta } from '../../shared/file-index/table.ts'

/** 同时读的目录数：太多会把文件句柄占满，太少在机械盘上慢 */
export const WALK_CONCURRENCY = 32

export interface Level {
  mtime: number
  files: string[]
  subdirs: string[]
}

/** 额外的跳过判断（Git 的 .gitignore 忽略的路径），rel 是相对根目录的路径 */
export type ExtraSkip = (rel: string, isDir: boolean) => boolean

export const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/** 读一层；目录没了返回 undefined */
export async function readLevel(
  root: string,
  rel: string,
  rule: SkipRule,
  extra?: ExtraSkip,
): Promise<Level | undefined> {
  const abs = rel ? path.join(root, rel) : root
  const [st, ents] = await Promise.all([
    stat(abs).catch(() => null),
    readdir(abs, { withFileTypes: true }).catch(() => null),
  ])
  if (!st?.isDirectory() || !ents) return undefined
  const files: string[] = []
  const subdirs: string[] = []
  for (const e of ents) {
    const r = joinRel(rel, e.name)
    if (e.isDirectory()) {
      if (!skipDir(rule, e.name, r) && !extra?.(r, true)) subdirs.push(e.name)
    } else if (e.isFile()) {
      if (!extra?.(r, false)) files.push(e.name)
    }
    // 链接、设备文件不收
  }
  return { mtime: st.mtimeMs, files, subdirs }
}

/**
 * 从 start（默认根目录）往下把整棵读进 table：读一层、放进去、再读新出现的子目录。
 * 返回增删（第一次建时全是新增）；onProgress 每读完 500 个目录报一次
 */
export async function readTree(
  table: NameTable,
  root: string,
  rule: SkipRule,
  opts: {
    start?: string[]
    extra?: ExtraSkip
    onProgress?: (dirs: number, files: number) => void
    signal?: AbortSignal
  } = {},
): Promise<TableDelta> {
  const queue = [...(opts.start ?? [''])]
  const delta: TableDelta = { added: [], removed: [] }
  let active = 0
  let dirs = 0
  let files = 0
  await new Promise<void>((resolve) => {
    const pump = () => {
      if (opts.signal?.aborted) queue.length = 0
      while (active < WALK_CONCURRENCY && queue.length) {
        const rel = queue.shift()!
        active++
        void readLevel(root, rel, rule, opts.extra)
          .then((lv) => {
            if (!lv) {
              delta.removed.push(...table.removeDir(rel))
              return
            }
            const d = table.setDir(rel, lv.mtime, lv.files, lv.subdirs)
            delta.added.push(...d.added)
            delta.removed.push(...d.removed)
            queue.push(...d.newDirs)
            dirs++
            files += lv.files.length
            if (dirs % 500 === 0) opts.onProgress?.(dirs, files)
          })
          .catch(() => {})
          .finally(() => {
            active--
            if (!queue.length && !active) resolve()
            else pump()
          })
      }
      if (!queue.length && !active) resolve()
    }
    pump()
  })
  opts.onProgress?.(dirs, files)
  return delta
}

/**
 * 目录核对（设计稿 5.4）：对每个已知目录 stat 一次，修改时间变了的重读这一层（新子目录接着往下读）。
 * 增删改名都会改所在目录的修改时间；只改内容不会，但内容和文件名索引无关。under 给了只核对这棵子树
 */
export async function verifyTree(
  table: NameTable,
  root: string,
  rule: SkipRule,
  opts: { under?: string; extra?: ExtraSkip; force?: boolean; limit?: number } = {},
): Promise<TableDelta & { checked: number; changedDirs: number }> {
  const under = opts.under?.replace(/^\/+|\/+$/g, '') ?? ''
  let list = [...table.allDirs()].filter((d) => !under || d.rel === under || d.rel.startsWith(`${under}/`))
  // 只核对前几个时先核对浅的（按文件夹取只核对它自己这一层）
  if (opts.limit !== undefined && list.length > opts.limit)
    list = list.sort((a, b) => a.rel.length - b.rel.length).slice(0, opts.limit)
  const stale: string[] = []
  for (let i = 0; i < list.length; i += 64) {
    const batch = list.slice(i, i + 64)
    const sts = await Promise.all(batch.map((d) => stat(d.rel ? path.join(root, d.rel) : root).catch(() => null)))
    sts.forEach((s, k) => {
      if (opts.force || !s || s.mtimeMs !== batch[k].mtime) stale.push(batch[k].rel)
    })
  }
  // 核对的起点自己还没进表（新建的子目录）：也读一遍
  if (under && !table.dir(under)) stale.push(under)
  const delta = stale.length
    ? await readTree(table, root, rule, { start: stale, extra: opts.extra })
    : { added: [], removed: [] }
  return { ...delta, checked: list.length, changedDirs: stale.length }
}
