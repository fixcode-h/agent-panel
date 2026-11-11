/**
 * 版本差异、跨项目对比的格子级差异放在这里算：几千行、几十列的表没有主键时要做 LCS，
 * 放主线程上算的时候页面卡住、鼠标拖不动。收 { id, a, b, key }，回 { id, diff }
 */
import { diffSheet, type DiffSide } from '@shared/sheet-diff'

self.onmessage = (e: MessageEvent<{ id: number; a: DiffSide; b: DiffSide; key: string }>) => {
  const { id, a, b, key } = e.data
  try {
    postMessage({ id, diff: diffSheet(a, b, key) })
  } catch (err) {
    postMessage({ id, error: (err as Error).message })
  }
}
