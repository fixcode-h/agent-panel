/**
 * 找回粘贴 / 拖进来的大文件的原路径（server/locate-file.ts）时，项目目录先查文件索引：按文件名精确找，再 stat 比大小和时间。
 * 查过索引的项目目录不再逐层走（以前每次粘贴都把每个项目走 4 层）；家目录下的桌面、下载这些不在索引里，照旧走
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { projectIndex, projectOfDir } from './registry.ts'

interface Wanted {
  name: string
  size: number
  mtime?: number
}

const SAME_TIME_MS = 2000
const READY_MS = 2000

export async function locateInIndexes<W extends Wanted>(wanted: W[], dirs: string[], loose: boolean) {
  const found = new Map<W, { path: string; diff: number }>()
  const indexed = new Set<string>()
  for (const dir of dirs) {
    const id = await projectOfDir(dir).catch(() => undefined)
    const idx = id ? await projectIndex(id) : undefined
    if (!idx || !(await idx.ready(READY_MS))) continue
    indexed.add(path.resolve(dir))
    for (const w of wanted) {
      const lower = w.name.toLowerCase()
      // 按名字找的结果是子串命中，这里只要整名一样的
      const hits = idx.find(w.name, { cap: 200 }).filter((h) => path.basename(h.abs).toLowerCase() === lower)
      for (const h of hits) {
        if (path.basename(h.abs) !== w.name) continue
        const s = await stat(h.abs).catch(() => null)
        if (!s?.isFile() || (!loose && s.size !== w.size)) continue
        const diff = w.mtime ? Math.abs(s.mtimeMs - w.mtime) : 0
        const had = found.get(w)
        if (!had || diff < had.diff) found.set(w, { path: h.abs, diff })
      }
    }
  }
  return { found, indexed, exact: (w: W) => (found.get(w)?.diff ?? Infinity) <= SAME_TIME_MS }
}
