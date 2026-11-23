/**
 * 盯几个文件的内容改动（ADR 0074）：打开着的表格、GM 的 gm.json、AssetForge 右栏选中的配置和它 include 的片段……
 * 以前这三处各写一份「盯所在目录 + 停手 300 毫秒 + 比修改时间」，现在都用这一份；目录监听和别的订阅者共用（dir.ts）。
 *
 * 保存时会连着来好几下事件（写临时文件、改名、改属性）：停 settleMs 没有新事件再看修改时间，
 * 和上次知道的不一样才回调，同一次保存只回调一次。文件被删了也算变了（mtime 是空串）
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { watchDir, type DirWatch } from './dir.ts'

export const SETTLE_MS = 300

export interface FileStamp {
  file: string
  /** 修改时间（ISO）；文件不在了是空串 */
  mtime: string
}

export async function mtimeOf(full: string) {
  const st = await stat(full).catch(() => undefined)
  return st?.isFile() ? st.mtime.toISOString() : ''
}

export interface FilesWatch {
  close(): void
  /** 盯不了的目录（不存在、网络盘、权限）里的文件 */
  unwatched: string[]
}

const fold = (n: string) => (process.platform === 'win32' ? n.toLowerCase() : n)

/**
 * 盯这些文件（绝对路径）。known 是调用方已经知道的修改时间（页面打开时读到的）：给了就以它为准，
 * 没给时先读一遍当基准（读完之前的改动不算）
 */
export function watchFiles(
  files: string[],
  onChange: (changed: FileStamp[]) => void,
  o: { settleMs?: number; known?: Record<string, string> } = {},
): FilesWatch {
  const last = new Map<string, string>()
  const ready = Promise.all(files.map(async (f) => last.set(f, o.known?.[f] ?? (await mtimeOf(f)))))
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const pending = new Set<string>()
  const check = async () => {
    timer = undefined
    await ready
    if (closed) return
    const list = [...pending]
    pending.clear()
    const changed: FileStamp[] = []
    for (const f of list) {
      const m = await mtimeOf(f)
      if (m === last.get(f)) continue
      last.set(f, m)
      changed.push({ file: f, mtime: m })
    }
    if (changed.length && !closed) onChange(changed)
  }
  const kick = (hit: string[]) => {
    for (const f of hit) pending.add(f)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void check(), o.settleMs ?? SETTLE_MS)
    timer.unref?.()
  }
  const byDir = new Map<string, Map<string, string[]>>()
  for (const f of files) {
    const d = path.dirname(f)
    const names = byDir.get(d) ?? new Map<string, string[]>()
    const n = fold(path.basename(f))
    names.set(n, [...(names.get(n) ?? []), f])
    byDir.set(d, names)
  }
  const watches: DirWatch[] = []
  const unwatched: string[] = []
  for (const [dir, names] of byDir) {
    const w = watchDir(dir, (name) => {
      // 有的系统不给文件名（或给的是临时文件名）：目录里盯着的都看一遍，修改时间没变的不会回调
      const hit = name ? names.get(fold(path.basename(name))) : undefined
      kick(hit ?? [...names.values()].flat())
    })
    if (w) watches.push(w)
    else unwatched.push(...[...names.values()].flat())
  }
  return {
    unwatched,
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      for (const w of watches) w.close()
    },
  }
}
