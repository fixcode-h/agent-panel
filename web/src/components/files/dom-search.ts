import { useEffect, useState } from 'react'
import { findHits } from '@/lib/file-search'

/** CSS 自定义高亮（::highlight）的名字，样式在 file-view.css */
const ALL = 'file-search'
const CURRENT = 'file-search-current'

type HighlightRegistry = Map<string, unknown>
type HighlightCtor = new (...ranges: Range[]) => unknown
const registry = () => (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
const HighlightImpl = () => (globalThis as { Highlight?: HighlightCtor }).Highlight

/** 把 root 里的文字连成一串，记下每个文字节点从哪开始：命中的位置换回 Range 用 */
function textMap(root: HTMLElement) {
  const nodes: { node: Text; start: number }[] = []
  let text = ''
  // 按钮里的字（代码块的「复制」「折行」）、读屏隐藏的字不算正文
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('button, [aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    nodes.push({ node: n as Text, start: text.length })
    text += (n as Text).data
  }
  return { nodes, text }
}

function pointAt(nodes: { node: Text; start: number }[], pos: number, end: boolean) {
  // 二分找 pos 落在哪个文字节点；落在两个节点交界处时，起点算后一个、终点算前一个
  let lo = 0
  let hi = nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (nodes[mid].start < pos || (!end && nodes[mid].start === pos)) lo = mid
    else hi = mid - 1
  }
  const { node, start } = nodes[lo]
  return { node, offset: Math.min(pos - start, node.data.length) }
}

/**
 * Markdown 阅读时的搜索：渲染好的文档是一整块 HTML，直接在 DOM 的文字里找，用 CSS 自定义高亮标出来（不改 DOM，
 * 不会和图表、公式渲染打架）。浏览器不支持 ::highlight 时退回「把当前那一处选中」。返回命中数。
 */
export function useDomSearch(
  root: React.RefObject<HTMLElement | null>,
  query: string,
  caseSensitive: boolean,
  index: number,
  seq: number,
  on: boolean,
) {
  const [ranges, setRanges] = useState<Range[]>([])
  // 找命中：内容变了（图画好、公式换上）也重找
  useEffect(() => {
    const box = root.current
    if (!box || !on || !query) {
      setRanges([])
      return
    }
    let frame = 0
    const scan = () => {
      frame = 0
      const { nodes, text } = textMap(box)
      const list = nodes.length
        ? findHits(text, query, caseSensitive).map((h) => {
            const r = document.createRange()
            const a = pointAt(nodes, h.from, false)
            const b = pointAt(nodes, h.to, true)
            r.setStart(a.node, a.offset)
            r.setEnd(b.node, b.offset)
            return r
          })
        : []
      setRanges(list)
    }
    scan()
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(scan)
    })
    mo.observe(box, { childList: true, subtree: true, characterData: true })
    return () => {
      mo.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [root, query, caseSensitive, on])

  // 标出来，并把当前那一处滚进视野
  useEffect(() => {
    const reg = registry()
    const Impl = HighlightImpl()
    const cur = ranges[Math.min(index, ranges.length - 1)]
    if (reg && Impl) {
      reg.set(ALL, new Impl(...ranges.filter((r) => r !== cur)))
      reg.set(CURRENT, new Impl(...(cur ? [cur] : [])))
    } else if (cur) {
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(cur)
    }
    const box = root.current
    if (cur && box) {
      // 先让它所在的元素进视野（屏幕外的块还没排版时量不出位置），再按量到的位置放到中间
      const el = cur.startContainer.parentElement
      const place = () => {
        const r = cur.getBoundingClientRect()
        const b = box.getBoundingClientRect()
        if (!r.height) return false
        if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - box.clientHeight / 2
        return true
      }
      if (!place()) {
        el?.scrollIntoView({ block: 'center' })
        requestAnimationFrame(place)
      }
    }
    return () => {
      reg?.delete(ALL)
      reg?.delete(CURRENT)
    }
    // seq 变了（再按一次下一个）也要重新滚过去
  }, [ranges, index, seq, root])

  return ranges.length
}
