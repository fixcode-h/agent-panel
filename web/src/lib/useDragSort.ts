import { useState, type DragEvent, type KeyboardEvent } from 'react'

/** 把列表里第 from 项挪到第 to 项的位置 */
export function moveItem<T>(list: T[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}

/**
 * 拖拽排序：用浏览器自带的拖放，列表很短，不值得引一个拖拽库。
 * 拿不了鼠标时也能排：聚焦后按 Alt + ↑ / ↓ 挪一格。
 */
export function useDragSort(onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const reset = () => {
    setDrag(null)
    setOver(null)
  }
  const itemProps = (i: number, count: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      setDrag(i)
      e.dataTransfer.effectAllowed = 'move'
      // Firefox 不设数据就不开始拖
      e.dataTransfer.setData('text/plain', String(i))
    },
    onDragOver: (e: DragEvent) => {
      if (drag === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (over !== i) setOver(i)
    },
    onDrop: (e: DragEvent) => {
      if (drag === null) return
      e.preventDefault()
      if (drag !== i) onMove(drag, i)
      reset()
    },
    onDragEnd: reset,
    onKeyDown: (e: KeyboardEvent) => {
      if (
        !e.altKey ||
        (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
      )
        return
      e.preventDefault()
      const to = i + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1)
      if (to >= 0 && to < count) onMove(i, to)
    },
  })
  return { itemProps, drag, over }
}
