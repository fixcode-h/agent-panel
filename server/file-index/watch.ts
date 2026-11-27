/**
 * 盯着改动（设计稿 5.2）：Windows / macOS 对根目录开一个递归监听（ReadDirectoryChangesW / FSEvents，一个句柄盯整棵树）。
 * Linux 上 Node 的递归监听是逐个目录建 inotify，上万个目录会碰上系统上限、编辑器改名替换时还会丢事件
 * （表格枚举扫描、GM 扫描都踩过），所以「自动」时 Linux 不盯，靠面板自己写文件的通知和定时核对。
 *
 * 事件只记「哪个目录脏了」，停 300 毫秒没有新事件再批量交出去；监听出错（缓冲溢出、目录被删）交给 onLost，
 * 由调用方做一次整体核对
 */
import { watchTree as sharedTree } from '../watch/tree.ts'
import type { FileIndexWatch } from '../../shared/file-index/types.ts'

export const SETTLE_MS = 300

/** 这个平台、这个设置下开不开系统监听 */
export const watchOn = (mode: FileIndexWatch, platform = process.platform) =>
  mode === 'on' || (mode === 'auto' && (platform === 'win32' || platform === 'darwin'))

export interface TreeWatch {
  close(): void
}

export function watchTree(
  root: string,
  onDirty: (dirs: Set<string>) => void,
  /** 通知漏了要整体核对；dead 为 true 时监听已经断了，要重新盯 */
  onLost: (why: string, dead: boolean) => void,
  skip: (rel: string) => boolean,
): TreeWatch | undefined {
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    if (!dirty.size) return
    const batch = new Set(dirty)
    dirty.clear()
    onDirty(batch)
  }
  // 系统监听和别的订阅者（表格枚举扫描、Lua GM 扫描）共用一个（server/watch/，ADR 0074）
  const w = sharedTree(
    root,
    (rel) => {
      if (rel === null) {
        // 没给文件名（溢出时会这样）：整体核对
        onLost('监听没给出文件名', false)
        return
      }
      if (skip(rel)) return
      // 变化的是这一项；它所在的目录要重读，它自己是目录时也重读它（新建的目录、改名进来的目录）
      const cut = rel.lastIndexOf('/')
      dirty.add(cut >= 0 ? rel.slice(0, cut) : '')
      dirty.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, SETTLE_MS)
    },
    { onLost: (why) => onLost(why, true), skipDir: (name) => skip(name) || name.startsWith('.') },
  )
  // 盯不了（网络盘、权限）：不报 onLost，状态写「不盯」，靠查询时的定时核对跟上（报了会核对完又来重盯，一直循环）
  if (!w) return undefined
  return {
    close: () => {
      if (timer) clearTimeout(timer)
      w.close()
    },
  }
}
