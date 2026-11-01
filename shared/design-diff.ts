import type { Component, Widget } from './umg.ts'

/**
 * AI 这一轮改了哪些控件：按控件 id 对比这一轮开始和结束时的树（主界面和各个子控件）。
 * 回复下面列出来，用户点一条就能选中那个控件；以前只有一段文字说明，改了什么得自己在画布上找
 */
export interface TreeChange {
  kind: 'add' | 'remove' | 'change' | 'rename'
  /** 在哪棵树：空是主界面，否则是子控件名 */
  tree: string
  name: string
  type: string
  /** 改了哪些：属性名、Slot（位置）、Class */
  keys?: string[]
  /** 改名前的名字 */
  from?: string
}

/** 一轮最多记这么多条：大改时列表太长没用，界面上写「还有 N 处」 */
export const MAX_CHANGES = 60

type Trees = { root: Widget; components: Component[] }

function index(t: Trees) {
  const out = new Map<string, { w: Widget; tree: string }>()
  const visit = (w: Widget, tree: string) => {
    out.set(`${tree}\u0000${w.id}`, { w, tree })
    for (const c of w.Children ?? []) visit(c, tree)
  }
  visit(t.root, '')
  for (const c of t.components) visit(c.Root, c.Name)
  return out
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function treeChanges(before: Trees, after: Trees): { list: TreeChange[]; total: number } {
  const a = index(before)
  const b = index(after)
  const list: TreeChange[] = []
  for (const [key, { w, tree }] of b) {
    const old = a.get(key)
    if (!old) {
      list.push({ kind: 'add', tree, name: w.Name, type: w.Type })
      continue
    }
    const keys = [...new Set([...Object.keys(old.w.Properties ?? {}), ...Object.keys(w.Properties ?? {})])].filter(
      (k) => !same(old.w.Properties?.[k], w.Properties?.[k]),
    )
    if (!same(old.w.Slot, w.Slot)) keys.push('Slot')
    if ((old.w.Class ?? '') !== (w.Class ?? '')) keys.push('Class')
    if (old.w.Name !== w.Name)
      list.push({
        kind: 'rename',
        tree,
        name: w.Name,
        type: w.Type,
        from: old.w.Name,
        ...(keys.length ? { keys } : {}),
      })
    else if (keys.length) list.push({ kind: 'change', tree, name: w.Name, type: w.Type, keys })
  }
  for (const [key, { w, tree }] of a) if (!b.has(key)) list.push({ kind: 'remove', tree, name: w.Name, type: w.Type })
  return { list: list.slice(0, MAX_CHANGES), total: list.length }
}
