/** 在后台线程算格子级差异（sheet-diff.worker.ts）；建不了后台线程时退回主线程算 */
import { useEffect, useState } from 'react'
import { diffSheet, type DiffSide, type SheetDiff } from '@shared/sheet-diff'

type Reply = { id: number; diff?: SheetDiff; error?: string }
let worker: Worker | null | undefined
let seq = 0
const waiting = new Map<number, (r: Reply | undefined) => void>()

function diffWorker() {
  if (worker !== undefined) return worker
  try {
    worker = new Worker(new URL('./sheet-diff.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Reply>) => {
      waiting.get(e.data.id)?.(e.data)
      waiting.delete(e.data.id)
    }
    // 后台线程出错（脚本加载失败）：手上等着的都退回主线程，以后也不再用它
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      const left = [...waiting.values()]
      waiting.clear()
      for (const f of left) f(undefined)
    }
  } catch {
    worker = null
  }
  return worker
}

/** 小表（几千格以内）直接算，省掉来回拷贝 */
const SMALL = 20_000

const cells = (s: DiffSide) => s.rows.reduce((n, r) => n + r.length, 0)

export function diffSheetAsync(a: DiffSide, b: DiffSide, key = ''): Promise<SheetDiff> {
  const here = () => Promise.resolve().then(() => diffSheet(a, b, key))
  if (cells(a) + cells(b) < SMALL) return here()
  const w = diffWorker()
  if (!w) return here()
  return new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, (r) => {
      if (!r) return void here().then(resolve, reject)
      if (r.error) reject(new Error(r.error))
      else resolve(r.diff!)
    })
    w.postMessage({
      id,
      a: { rows: a.rows, from: a.from, names: a.names },
      b: { rows: b.rows, from: b.from, names: b.names },
      key,
    })
  })
}

/**
 * 两边变了就在后台重算；算好之前返回 null（显示转圈），算出错给 error。
 * 两边的对象要稳定（调用方 useMemo），不然每次渲染都重算
 */
export function useSheetDiff(sides: { a: DiffSide; b: DiffSide } | null, key = '') {
  const [state, setState] = useState<{ for: unknown; diff?: SheetDiff; error?: string }>({ for: null })
  useEffect(() => {
    if (!sides) return
    let live = true
    diffSheetAsync(sides.a, sides.b, key).then(
      (diff) => live && setState({ for: sides, diff }),
      (e) => live && setState({ for: sides, error: (e as Error).message }),
    )
    return () => {
      live = false
    }
  }, [sides, key])
  return state.for === sides && sides ? state : { diff: undefined, error: undefined }
}
