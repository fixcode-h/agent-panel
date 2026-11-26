/**
 * 工具网关的调用记录（ADR 0084）：设置「调用记录」页先按契约取一页，之后跟着服务端推送的 tool-call 事件走（新记录、补上执行结果），不轮询。
 * 演示版没有推送通道：演示后端在页面里发同名的窗口事件（web/src/lib/demo/demo-tool-gateway.ts）
 */
import { useEffect, useRef } from 'react'
import type { CallRecord } from '@shared/tool-gateway/types'
import { openPageStream } from './page-stream'

const demo = !!import.meta.env.VITE_DEMO
export const DEMO_TOOL_CALL_EVENT = 'agent-panel:tool-call'

/** 每来一条（新的或补了结果的）调一次 onCall */
export function useToolCallFeed(onCall: (r: CallRecord) => void) {
  const cb = useRef(onCall)
  // 回调每次渲染都是新的：放进 ref，事件流只开一次
  useEffect(() => {
    cb.current = onCall
  })
  useEffect(() => {
    if (demo) {
      const h = (e: Event) => cb.current((e as CustomEvent<{ call: CallRecord }>).detail.call)
      window.addEventListener(DEMO_TOOL_CALL_EVENT, h)
      return () => window.removeEventListener(DEMO_TOOL_CALL_EVENT, h)
    }
    const stream = openPageStream()
    stream.on('tool-call', (e) => {
      try {
        cb.current((JSON.parse(e.data) as { call: CallRecord }).call)
      } catch {
        // 坏的一条推送不影响下一条
      }
    })
    return () => stream.close()
  }, [])
}
