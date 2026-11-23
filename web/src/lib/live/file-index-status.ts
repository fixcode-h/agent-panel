/**
 * 项目文件索引的状态（项目设置的状态卡、侧栏底部的状态条共用）：先取一次，之后跟着服务端推送的 file-index 事件走，不轮询。
 * 取状态本身会把这个项目的索引拉起来（读回落盘或开始建），所以侧栏一打开项目，索引就开始准备了。
 * 演示版没有推送通道：演示后端在页面里发同名的窗口事件（web/src/lib/demo/demo-file-index.ts）
 */
import { useEffect, useState } from 'react'
import { fileIndexContract as C } from '@shared/api-contract/file-index'
import type { FileIndexStatus } from '@shared/file-index/types'
import { call } from '@/lib/api/call'
import { openPageStream } from './page-stream'

const demo = !!import.meta.env.VITE_DEMO
/** 演示后端在页面里发的事件名（detail 和推送的数据一样） */
export const DEMO_FILE_INDEX_EVENT = 'agent-panel:file-index'

export function useFileIndexStatus(projectId: string | undefined, onError?: (e: Error) => void) {
  const [s, setS] = useState<FileIndexStatus>()
  useEffect(() => {
    setS(undefined)
    if (!projectId) return
    let alive = true
    call(C.status, { params: { id: projectId } })
      .then((x) => alive && setS(x))
      .catch((e) => alive && onError?.(e as Error))
    const take = (m: { projectId: string; status: FileIndexStatus }) => {
      if (alive && m.projectId === projectId) setS(m.status)
    }
    if (demo) {
      const h = (e: Event) => take((e as CustomEvent).detail)
      window.addEventListener(DEMO_FILE_INDEX_EVENT, h)
      return () => {
        alive = false
        window.removeEventListener(DEMO_FILE_INDEX_EVENT, h)
      }
    }
    const stream = openPageStream()
    stream.on('file-index', (e) => {
      try {
        take(JSON.parse(e.data))
      } catch {
        // 坏的一条推送不影响下一条
      }
    })
    return () => {
      alive = false
      stream.close()
    }
    // onError 每次渲染都是新的：只按项目重新订阅
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
  return [s, setS] as const
}
