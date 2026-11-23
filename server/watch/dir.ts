/**
 * 盯文件改动的唯一底层（ADR 0074）：一个目录一个系统监听，所有订阅者共用，最后一个走了才关。
 * 以前表格（打开着的表格、枚举扫描）、UE（GM 文件、AssetForge 配置、Lua GM 扫描）、文件索引各开各的 fs.watch：
 * 同一个目录被盯好几遍（Windows 占句柄，Linux 碰 inotify 上限），有的设了 persistent: false、有的没设，
 * 有的盯文件本身（编辑器改名替换保存后就盯丢了）。
 *
 * 盯的是目录不是文件：编辑器、Excel 保存是先写临时文件再改名替换，盯文件本身改名后就没事件了。
 * 盯不了（目录不存在、网络盘、权限）返回 undefined，调用方照旧能手动刷新
 */
import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

/** name：变化的文件名（相对这个目录；有的系统不给，是 null）。recursive 的监听给的是相对根的路径 */
export type DirListener = (name: string | null) => void

interface Shared {
  w: FSWatcher
  listeners: Set<DirListener>
  /** 监听出错（目录被删、缓冲溢出）时告诉订阅者 */
  lost: Set<(why: string) => void>
}

const shared = new Map<string, Shared>() // 模块状态：运行时，订阅者都走了就关
const keyOf = (dir: string, recursive: boolean) => {
  const p = path.resolve(dir)
  return `${recursive ? 'r' : 'd'}:${process.platform === 'win32' ? p.toLowerCase() : p}`
}

export interface DirWatch {
  close(): void
}

/**
 * 订阅一个目录的改动。recursive 只在 Windows / macOS 用（一个句柄盯整棵树）；
 * Linux 上 Node 的递归监听是逐个文件盯、改名替换后会丢事件，要整棵树的用 tree.ts 的 watchTree
 */
export function watchDir(
  dir: string,
  on: DirListener,
  o: { recursive?: boolean; onLost?: (why: string) => void } = {},
): DirWatch | undefined {
  const key = keyOf(dir, !!o.recursive)
  let s = shared.get(key)
  if (!s) {
    let w: FSWatcher
    const listeners = new Set<DirListener>()
    const lost = new Set<(why: string) => void>()
    try {
      w = watch(dir, { persistent: false, recursive: !!o.recursive }, (_e, name) => {
        const n = name ? String(name) : null
        for (const l of [...listeners]) l(n)
      })
    } catch {
      return undefined
    }
    w.on('error', (e) => {
      shared.delete(key)
      try {
        w.close()
      } catch {
        // 已经关了
      }
      for (const l of [...lost]) l((e as Error).message)
    })
    s = { w, listeners, lost }
    shared.set(key, s)
  }
  const cur = s
  cur.listeners.add(on)
  if (o.onLost) cur.lost.add(o.onLost)
  let closed = false
  return {
    close: () => {
      if (closed) return
      closed = true
      cur.listeners.delete(on)
      if (o.onLost) cur.lost.delete(o.onLost)
      if (cur.listeners.size || shared.get(key) !== cur) return
      shared.delete(key)
      try {
        cur.w.close()
      } catch {
        // 已经关了
      }
    },
  }
}

/** 现在开着几个系统监听（设置 →「数据」、排查句柄用） */
export const openDirWatches = () => shared.size
