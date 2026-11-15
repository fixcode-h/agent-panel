import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { TaskHtmlCard } from './TaskHtmlCard'

/**
 * 回复正文里 HTML 卡片的占位（web/src/lib/markdown/html-cards.ts 放的）挂上真的卡片：正文是 HTML 字符串，
 * 卡片要用 React 组件（缩略预览、菜单），所以渲染完找到占位、用 createPortal 挂进去。
 * 正文换了（html 变了）占位跟着重建，重新找一遍
 */
export function useHtmlCards(root: React.RefObject<HTMLDivElement | null>, html: string, live?: boolean) {
  const [slots, setSlots] = useState<HTMLElement[]>([])
  useLayoutEffect(() => {
    const el = root.current
    const found = el && !live ? [...el.querySelectorAll<HTMLElement>('[data-html-card-slot]')] : []
    setSlots((old) => (!old.length && !found.length ? old : found))
  }, [root, html, live])
  return slots.map((s, i) =>
    createPortal(
      <TaskHtmlCard path={s.dataset.path ?? ''} variant={s.dataset.variant === 'small' ? 'small' : 'large'} />,
      s,
      `${i}:${s.dataset.path}`,
    ),
  )
}
