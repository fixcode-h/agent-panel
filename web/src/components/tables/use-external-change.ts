import { useEffect, useRef } from 'react'
import { tablesApi } from '@/lib/tables-api'

/** 隔多久看一次打开着的文件 */
const POLL_MS = 4000

/**
 * 外部改动检测：当前打开的文件每几秒看一次修改时间，和打开时的不一样就回调（被 Excel / WPS 或版本控制改了）。
 * 页面在后台时不看；busy（正在保存、切换版本）时不看，免得把自己写的当成外面改的
 */
export function useExternalChange(
  projectId: string,
  doc: { path: string; mtime: string } | undefined,
  busy: React.RefObject<boolean>,
  onChanged: (path: string, mtime: string) => void,
) {
  const cb = useRef(onChanged)
  cb.current = onChanged
  const path = doc?.path
  const mtime = doc?.mtime
  useEffect(() => {
    if (!path || !mtime) return
    let live = true
    let reported = ''
    const tick = () => {
      if (document.visibilityState !== 'visible' || busy.current) return
      tablesApi
        .stat(projectId, path)
        .then((s) => {
          // 同一个新时间只报一次；文件被删了不在这里报（打开、保存时会说）
          if (!live || busy.current || !s.mtime || s.mtime === mtime || s.mtime === reported) return
          reported = s.mtime
          cb.current(path, s.mtime)
        })
        // 看不了（服务没开、网络断）不打扰：这只是提醒，保存时还有修改时间检查兜底
        .catch(() => {})
    }
    const timer = setInterval(tick, POLL_MS)
    window.addEventListener('focus', tick)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', tick)
    }
  }, [projectId, path, mtime, busy])
}
