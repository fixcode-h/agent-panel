import { useEffect, useRef } from 'react'
import type { useConversationScroll } from '@/components/chat/ConversationShell'
import { ANCHOR_RETRY_MS, ANCHOR_TRIES, lastSummaryHead } from '@/lib/message-anchor'

/**
 * 子对话面板：父对话里点了它的结果卡片（at 是点击的时间戳）时，滚到最后一份总结的标题，
 * 定格在那（后面的输出不把它顶走）并闪一下。子对话是刚打开的，消息异步到，多试几次；
 * 找不到总结（还没写、旧对话）就停在原处
 */
export function useSummaryJump(
  scroller: ReturnType<typeof useConversationScroll>,
  at: number | undefined,
  taskId: string | undefined,
  count: number | undefined,
) {
  const done = useRef(0)
  useEffect(() => {
    if (!at || done.current === at || !taskId) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      const el = scroller.el.current
      // 右栏页签刚切过来时容器还是隐藏的（display:none），量不出位置，等它显示出来再滚
      const head = el?.clientHeight ? lastSummaryHead(el) : null
      if (el && head) {
        done.current = at
        // 连点两次也要再闪：先去掉、强制重排再加上，动画才会重新开始
        head.removeAttribute('data-summary-flash')
        void head.offsetWidth
        head.setAttribute('data-summary-flash', '')
        // 刚打开的面板头几帧还会贴底（容器挂上时重置成跟随最新内容）、Markdown 也还在长高：
        // 隔一会儿再对齐几次，直到标题停在顶上
        let left = 6
        const align = () => {
          // 回复顶上吸住的署名行（data-reply-head）会盖住标题：让出它的高度
          const cover = el.querySelector<HTMLElement>('[data-reply-head="sticky"]')?.offsetHeight ?? 0
          const off = head.getBoundingClientRect().top - el.getBoundingClientRect().top - cover - 8
          if (Math.abs(off) > 2) {
            scroller.unpin()
            el.scrollTop += off
          }
          if (--left > 0) timer = setTimeout(align, ANCHOR_RETRY_MS)
        }
        align()
        return
      }
      if (++tries >= ANCHOR_TRIES) return
      timer = setTimeout(attempt, ANCHOR_RETRY_MS)
    }
    attempt()
    return () => clearTimeout(timer)
    // 只看点击、对话和消息条数：scroller 每次渲染都是新对象，按它比会反复滚
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [at, taskId, count])
}
