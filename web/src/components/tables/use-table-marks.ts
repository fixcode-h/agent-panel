/**
 * 表格页的「最近打开」和「收藏」：按项目记在本机（每个人自己的习惯，不进项目、不跟别人共享）。
 * 读写本机存储都包在 try 里：隐私模式、存储被禁用时照样能用，只是不记
 */
import { useCallback, useEffect, useState } from 'react'

const RECENT_MAX = 10

function read(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function write(key: string, v: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {}
}

export function useTableMarks(projectId: string, active: string | undefined) {
  const rk = `tables-recent:${projectId}`
  const fk = `tables-fav:${projectId}`
  const [recent, setRecent] = useState(() => read(rk))
  const [favs, setFavs] = useState(() => read(fk))
  useEffect(() => {
    setRecent(read(rk))
    setFavs(read(fk))
  }, [rk, fk])
  useEffect(() => {
    if (!active) return
    setRecent((r) => {
      if (r[0] === active) return r
      const next = [active, ...r.filter((x) => x !== active)].slice(0, RECENT_MAX)
      write(rk, next)
      return next
    })
  }, [active, rk])
  const toggleFav = useCallback(
    (path: string) =>
      setFavs((f) => {
        const next = f.includes(path) ? f.filter((x) => x !== path) : [...f, path]
        write(fk, next)
        return next
      }),
    [fk],
  )
  /** 文件没了（删了、改名了）就不列 */
  const prune = useCallback(
    (exists: (p: string) => boolean) => ({
      recent: recent.filter(exists),
      favs: favs.filter(exists),
    }),
    [recent, favs],
  )
  return { prune, toggleFav, isFav: (p: string) => favs.includes(p) }
}
