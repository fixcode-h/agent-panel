import { useEffect, useRef, type RefObject } from 'react'
import { t } from '@shared/i18n'

/**
 * 诊断报告的候选方案表（分析稿 U7）：原来只有内容那么宽，选定的方案只在表头写了「（选定）」。
 * 这里认出这张表，表撑满正文宽度、选定的那一列整列上色（样式在 index.css 的 data-chosen-table / data-chosen）。
 * 表是 Markdown 画的（shared/bug-diagnosis-md.ts 的 optionsTable，表头「方案 A（选定）」），
 * 不改生成 Markdown 的那一边：只在界面上按表头认，Markdown 重画时跟着重新标
 */
export function markChosenColumns(root: HTMLElement) {
  const mark = t('选定')
  for (const table of root.querySelectorAll('table')) {
    const head = table.tHead?.rows[0] ?? table.rows[0]
    if (!head) continue
    // 第一列是「做法 / 修得全…」这些项目名，不算方案
    const col = [...head.cells].findIndex((c, i) => i > 0 && (c.textContent ?? '').includes(mark))
    if (col < 0) {
      table.removeAttribute('data-chosen-table')
      continue
    }
    table.setAttribute('data-chosen-table', '')
    for (const row of table.rows)
      for (const [i, cell] of [...row.cells].entries()) cell.toggleAttribute('data-chosen', i === col)
  }
}

/**
 * 正文换了（换版本、Markdown 异步画完）就重新标一遍：只听子节点增删，标记属性本身不会再触发。
 * 每次渲染都看一眼正文那个节点还是不是原来那个：弹窗的 Portal 晚一拍才挂上，
 * 在弹窗和右栏之间切换时正文整块重挂，挂到新节点上要重新听
 */
export function useChosenColumn(ref: RefObject<HTMLElement | null>) {
  const seen = useRef<{ el: HTMLElement; ob: MutationObserver } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (seen.current?.el === el) return
    seen.current?.ob.disconnect()
    seen.current = null
    if (!el) return
    markChosenColumns(el)
    const ob = new MutationObserver(() => markChosenColumns(el))
    ob.observe(el, { childList: true, subtree: true })
    seen.current = { el, ob }
  })
  // 卸载时停止监听
  useEffect(() => () => seen.current?.ob.disconnect(), [])
}
